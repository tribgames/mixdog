//! `remote-idle-state-cases`, "goal state snapshots are idempotent and leave clock-less Goals untouched": Node's
//! `publicGoal` and `goalStateSnapshot` (`runtime-core/goal-state.mjs`) as the session's Goal lane publishes them.
//! `visible_goal` with nothing suppressed is the lane's `goalStateSnapshot` (null in, null out).

use mixdog_core_goal::goal::js::Goal;
use mixdog_core_goal::goal::state::public_goal;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::goal_lane::visible_goal;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/remote-idle-state-cases/golden.json");
const CASE: &str = "goal state snapshots are idempotent and leave clock-less Goals untouched";

/// The lane crosses as JSON: a key Node set to `undefined` is absent for every reader (the manifest's `normalised`).
fn as_read(value: &Exact) -> Exact {
    match value {
        Exact::Object(entries) => {
            Exact::Object(entries.iter().filter(|(_, v)| *v != Exact::Undefined).map(|(k, v)| (k.clone(), as_read(v))).collect())
        }
        Exact::Array(items) => Exact::Array(items.iter().map(as_read).collect()),
        other => other.clone(),
    }
}

fn goal(value: &Exact) -> Goal {
    match value.to_plain().expect("a plain recorded Goal") {
        Value::Object(goal) => goal,
        other => panic!("recording: a Goal is an object, found {other}"),
    }
}

#[test]
fn goal_state_snapshots_are_idempotent_and_leave_clock_less_goals_untouched() {
    let golden = Exact::decode(&serde_json::from_str(&GOLDEN).expect("golden is JSON")).expect("golden decodes");
    let recorded = golden
        .get("cases")
        .as_array()
        .iter()
        .find(|case| case.get("case").as_str() == CASE)
        .unwrap_or_else(|| panic!("recording: no case {CASE:?}"))
        .get("observed");

    let plain = goal(recorded.get("plain"));
    let plain_snapshot = visible_goal(Some(&plain), "");
    let goal_input = goal(recorded.get("goalInput"));
    let now = recorded.get("now").as_f64();
    let running = public_goal(Some(&goal_input), now).expect("a Goal reads as a Goal");
    let anchored = visible_goal(Some(&running), "").expect("a visible Goal");
    let again = visible_goal(Some(&anchored), "").expect("a visible Goal");
    let observed = json!({
        "plain": plain,
        "plainSnapshot": plain_snapshot,
        // Node returns the input object itself; what a reader sees of that is an equal value.
        "plainSameObject": plain_snapshot.as_ref() == Some(&plain),
        "nullIn": visible_goal(None, ""),
        "goalInput": goal_input,
        "now": now,
        "running": running,
        "anchored": anchored,
        "anchoredSnapshotAt": anchored["snapshotAt"],
        "anchoredTimeUsedMs": anchored["timeUsedMs"],
        "remainingMs": anchored["remainingMs"],
        "deadlineAt": anchored["deadlineAt"],
        "idempotent": again == anchored,
    });
    assert_eq!(Exact::plain(&observed), as_read(recorded));
}
