use serde_json::Value;

use super::AgentKind;
use super::stall_first_byte_abort_s;
use super::stall_warn_ms;

const GOLDEN: &str = include_str!("../../../../fixtures/stall-thresholds/golden.json");

#[test]
fn the_stall_warn_deadline_is_the_one_node_resolves() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let variable = case["env"].as_str().map(str::to_owned);
        let env = move |name: &str| if name == "STALL_TIMEOUT_S" { variable.clone() } else { None };
        for row in case["rows"].as_array().unwrap() {
            let agent = row["agent"].as_str().filter(|a| !a.is_empty());
            let kind = AgentKind { name: agent, hidden: row["hidden"] == true, stall_cap_idle_seconds: row["stallCapIdleSeconds"].as_i64() };
            let want = row["warn"].as_i64().unwrap() * 1000;
            assert_eq!(stall_warn_ms(kind, &env), want, "STALL_TIMEOUT_S={} agent={}", case["env"], row["agent"]);
        }
    }
}

#[test]
fn the_first_byte_abort_is_the_one_node_resolves() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let variable = case["env"].as_str().map(str::to_owned);
        let env = move |name: &str| if name == "STALL_TIMEOUT_S" { variable.clone() } else { None };
        for row in case["rows"].as_array().unwrap() {
            let agent = row["agent"].as_str().filter(|a| !a.is_empty());
            let kind = AgentKind { name: agent, hidden: row["hidden"] == true, stall_cap_idle_seconds: row["stallCapIdleSeconds"].as_i64() };
            assert_eq!(stall_first_byte_abort_s(kind, &env), row["firstByteAbort"].as_i64().unwrap(), "STALL_TIMEOUT_S={} agent={}", case["env"], row["agent"]);
        }
    }
}

#[test]
fn the_first_byte_abort_variable_moves_the_window_within_its_bounds() {
    let lead = AgentKind { name: Some("lead"), ..AgentKind::default() };
    let with = |raw: &'static str| move |name: &str| (name == "MIXDOG_STALL_FIRST_BYTE_ABORT_S").then(|| raw.to_owned());
    assert_eq!(stall_first_byte_abort_s(lead, &with("120")), 120);
    // Held to 5..=600 s; a value that is not a positive integer is the 300 s default.
    assert_eq!(stall_first_byte_abort_s(lead, &with("1")), 5);
    assert_eq!(stall_first_byte_abort_s(lead, &with("9000")), 600);
    assert_eq!(stall_first_byte_abort_s(lead, &with("0")), 300);
    assert_eq!(stall_first_byte_abort_s(lead, &with("soon")), 300);
    // Never beyond the agent's own abort: a worker's 300 s deadline caps a 600 s window.
    let worker = AgentKind { name: Some("worker"), ..AgentKind::default() };
    assert_eq!(stall_first_byte_abort_s(worker, &with("600")), 300);
    assert_eq!(stall_first_byte_abort_s(worker, &with("90")), 90);
}
