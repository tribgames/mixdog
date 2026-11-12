//! `session-usage-totals.test.mjs:83`: the live agent list rows carry the in-memory session totals, against Node's
//! real list over the real session progress (`fixtures/session-usage-totals/golden.json` `live`,
//! `benchmarks/rust-core/recorders/record-session-usage-totals.mjs`). The core publishes live rows on the status
//! pulse (`AgentToolStatus::status`, Node `statusFor` with `memoryOnly`), so each recorded pulse is replayed as the
//! pulse reads a session this process does not host: its progress state empty, its policy the held role
//! policy (`RolePolicies`, asked for and resolved as `status` does), the row built by `worker_status_row`.

use serde_json::Value;

use super::*;

#[test]
fn the_live_rows_of_each_pulse_equal_nodes() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../fixtures/session-usage-totals/golden.json")).unwrap();
    let live = &golden["live"];
    let session = live["session"].as_object().unwrap().clone();
    let tag = live["tag"].as_str().unwrap();
    let now = live["now"].as_i64().unwrap();
    let policies = RolePolicies::default();
    let pulses = live["pulses"].as_array().unwrap();
    assert_eq!(pulses.len(), 2);
    for (n, want) in pulses.iter().enumerate() {
        let mut pending = Vec::new();
        let mut worker = WorkerLive::default();
        worker.policy = policies.get(&text(&session, "agent").unwrap(), &mut pending);
        let row = worker_status_row(&WorkerStatus {
            tag,
            session: &session,
            live: &worker,
            awaiting_user: None,
            messages: count_of(&session, "messages", "messageCount"),
            tools: count_of(&session, "tools", "toolCount"),
            index_turn_started_at: None,
            todo: None,
            now,
        });
        policies.resolve(pending);
        assert_eq!(Value::Array(vec![Value::Object(row)]), *want, "pulse {n}");
    }
    // Node's list read outside the pulse resolves the role at once: the settled pulse is that row.
    assert_eq!(pulses[1], live["rows"]);
}
