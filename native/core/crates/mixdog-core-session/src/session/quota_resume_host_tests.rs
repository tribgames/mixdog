//! `fireQuotaResume`'s decision against the Node recording (`fixtures/quota-resume-fire`, Node's
//! real `createQuotaResumeLane` over its real store): for each recorded session state, the step
//! the Rust lane takes is the answer Node gave (`fired` / `rejected` / a thrown failure are the
//! Goal revival or the retry it went on to).

use serde_json::Value;

use super::quota_lane::FireFacts;
use super::quota_lane::FireStep;
use super::quota_lane::fire_step;
use super::quota_lane::retained_retry_input;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/quota-resume-fire/golden.json")).unwrap()
}

/// The step Node's answer shows.
fn recorded_step(answer: &Value, entry_key: &str, goal: &str) -> FireStep {
    match answer["outcome"].as_str() {
        Some("stale") => FireStep::Stale,
        Some("busy") => FireStep::Busy,
        Some("superseded") => FireStep::Superseded,
        Some("unreplayable") => FireStep::Unreplayable,
        // `fired`, `rejected`, or the failure the Goal revival raised: the lane went on.
        _ if goal.is_empty() => FireStep::Retry { turn_key: entry_key.to_owned() },
        _ => FireStep::ResumeGoal { turn_key: entry_key.to_owned(), goal_id: goal.to_owned() },
    }
}

#[test]
fn a_fire_takes_the_step_nodes_lane_took() {
    let golden = golden();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 17);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let items = case["items"].as_array().unwrap().clone();
        let messages = case["messages"].as_array().unwrap().clone();
        let goal = case["suspendedGoal"].as_str().unwrap();
        let generation = case["firedGeneration"].as_u64().unwrap();
        let state = &case["state"];
        let blocked = state["busy"] == Value::Bool(true) || state["commandBusy"] == Value::Bool(true) || state["pending"].as_u64() != Some(0);
        let retained = retained_retry_input(&messages).is_some();
        // The first fire meets the queued entry; a repeat meets what the first left.
        for (at, answer) in case["answers"].as_array().unwrap().iter().enumerate() {
            let entry = if at == 0 { &case["entry"] } else { &case["after"]["entry"] };
            let entry = entry.as_object().map(|entry| (entry["turnKey"].as_str().unwrap().to_owned(), entry["generation"].as_u64().unwrap()));
            let entry_key = entry.as_ref().map(|(key, _)| key.clone()).unwrap_or_default();
            let suspended = |key: &str| if key == entry_key { goal.to_owned() } else { String::new() };
            let claimed = |_: &str| false;
            let facts = FireFacts {
                entry: entry.as_ref().map(|(key, generation)| (key.as_str(), *generation)),
                blocked,
                items: &items,
                retained,
                suspended: &suspended,
                claimed: &claimed,
            };
            assert_eq!(fire_step(generation, &facts), recorded_step(answer, &entry_key, goal), "{name} #{at}");
        }
    }
}

#[test]
fn a_claimed_turn_is_stale() {
    let golden = golden();
    let case = golden["cases"].as_array().unwrap().iter().find(|case| case["name"] == "prompt replayed").unwrap();
    let items = case["items"].as_array().unwrap().clone();
    let key = case["entry"]["turnKey"].as_str().unwrap();
    let generation = case["entry"]["generation"].as_u64().unwrap();
    let none = |_: &str| String::new();
    let claimed = |turn: &str| turn == key;
    let facts = FireFacts { entry: Some((key, generation)), blocked: false, items: &items, retained: false, suspended: &none, claimed: &claimed };
    assert_eq!(fire_step(generation, &facts), FireStep::Stale);
}
