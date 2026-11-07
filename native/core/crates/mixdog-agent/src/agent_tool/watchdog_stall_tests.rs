use serde_json::Value;

use super::AgentKind;
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
