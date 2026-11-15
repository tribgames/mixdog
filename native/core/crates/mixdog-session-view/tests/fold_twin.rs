//! The Rust thread fold against the recording of the TypeScript one (`tests/goldens/fold.json`, written by
//! `tests/recorders/record-fold.mjs`): every feed (the recorded Node session states, a real turn's notifications, the rows of the
//! rows golden and synthetic feeds: interleaved deltas, out-of-order results, aggregate merges, a Stop during tools, history resets,
//! approvals pending and resolved, every section) is folded step by step and the projected state, as a UI reads it, equals the
//! recorded one after each snapshot and notification. For the recorded Node session states the projected state also equals the state
//! Node recorded for the step.

use mixdog_app_protocol::JsonRpcNotification;
use mixdog_app_protocol::ServerRequest;
use mixdog_app_server_client::FeedStamp;
use mixdog_app_server_client::ThreadFold;
use mixdog_app_server_client::ThreadReducer;
use mixdog_session_view::reducer::SessionReducer;
use mixdog_session_view::state::SessionFold;
use mixdog_session_view::state::desktop_session_state;
use mixdog_session_view::state::framed_session_state;
use mixdog_session_view::state::frames_of;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    serde_json::from_str(include_str!("goldens/fold.json")).expect("the recording is JSON")
}

/// The path of the first difference of two values (numbers compared as numbers), `None` when they are equal. A path, not the
/// values: a state is large.
fn difference(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => (x.as_f64() != y.as_f64()).then(|| path.to_owned()),
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys()) {
                match (x.get(key), y.get(key)) {
                    (Some(p), Some(q)) => {
                        if let Some(found) = difference(p, q, &format!("{path}.{key}")) {
                            return Some(found);
                        }
                    }
                    _ => return Some(format!("{path}.{key}")),
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}.length"));
            }
            x.iter().zip(y).enumerate().find_map(|(at, (p, q))| difference(p, q, &format!("{path}[{at}]")))
        }
        _ => (a != b).then(|| path.to_owned()),
    }
}

/// Folds a feed step by step; `each` sees the fold, the server requests and the host's shell jobs after every step.
fn replay(feed: &Value, mut each: impl FnMut(usize, &Value, &SessionFold, &[ServerRequest], Option<&Value>)) {
    let reducer = SessionReducer;
    let stamp: FeedStamp = serde_json::from_value(json!({ "id": "lead", "epoch": "e", "seq": 0 })).expect("a stamp");
    let mut state: Option<Value> = None;
    let mut requests: Vec<ServerRequest> = Vec::new();
    let mut host: Option<Value> = None;
    for (at, step) in feed["steps"].as_array().expect("steps").iter().enumerate() {
        if let Some(list) = step.get("requests") {
            requests = list.as_array().expect("requests").iter().map(|r| serde_json::from_value(r.clone()).expect("a server request")).collect();
        }
        if let Some(jobs) = step.get("hostShellJobs") {
            host = Some(jobs.clone());
        }
        let params = &step["params"];
        let next = match &state {
            _ if step["method"] == "thread/snapshot" => reducer.initial(params),
            Some(held) => {
                let notification: JsonRpcNotification = serde_json::from_value(json!({ "method": step["method"], "params": params })).expect("a notification");
                reducer.apply(held, &notification)
            }
            None => panic!("the feed does not begin with a snapshot"),
        };
        let fold: SessionFold = ThreadFold { feed: stamp.clone(), state: next.clone() };
        each(at, step, &fold, &requests, host.as_ref());
        state = Some(next);
    }
}

fn name(feed: &Value) -> &str {
    feed["name"].as_str().expect("a name")
}

#[test]
fn every_feed_projects_as_the_recorded_one() {
    let golden = golden();
    let feeds = golden["feeds"].as_array().expect("feeds");
    assert!(feeds.len() > 20, "the recording covers the recorded and the synthetic feeds: {} feeds", feeds.len());
    let mut steps = 0;
    let mut mismatches = Vec::new();
    for feed in feeds {
        replay(feed, |at, step, fold, requests, host| {
            steps += 1;
            let label = format!("{} step {at} {}", name(feed), step["method"].as_str().unwrap_or_default());
            if let Some(found) = difference(&desktop_session_state(fold, requests, host), &step["state"], "") {
                mismatches.push(format!("{label}: state{found}"));
            }
            if framed_session_state(fold, requests, host)["structureRevision"] != step["framed"] {
                mismatches.push(format!("{label}: the framed revision"));
            }
            if frames_of(fold) != step["frames"].as_u64().expect("frames") {
                mismatches.push(format!("{label}: the frame count"));
            }
        });
    }
    assert!(steps > 250, "{steps} steps");
    assert!(mismatches.is_empty(), "{} steps differ, first: {:?}", mismatches.len(), mismatches.iter().take(5).collect::<Vec<_>>());
}

#[test]
fn the_recorded_node_session_states_are_reproduced_field_for_field() {
    let golden = golden();
    let feed = golden["feeds"].as_array().expect("feeds").iter().find(|feed| name(feed) == "session-state").expect("the session-state feed");
    let mut compared = 0;
    let mut mismatches = Vec::new();
    replay(feed, |at, step, fold, requests, host| {
        let Some(node) = step.get("node") else { return };
        compared += 1;
        let mut state = desktop_session_state(fold, requests, host);
        // `structureRevision` counts the fold's own row changes; a recorded Node state states none.
        assert!(state["structureRevision"].is_u64(), "step {at}: structureRevision");
        state.as_object_mut().expect("a state").remove("structureRevision");
        if let Some(found) = difference(&state, &node["state"], "") {
            mismatches.push(format!("{} (step {at}): state{found}", node["step"].as_str().unwrap_or_default()));
        }
    });
    assert_eq!(compared, 16, "every recorded Node state is compared");
    assert!(mismatches.is_empty(), "{} differ, first: {:?}", mismatches.len(), mismatches.iter().take(5).collect::<Vec<_>>());
}

#[test]
fn the_recording_holds_what_the_task_names() {
    let golden = golden();
    let names: Vec<&str> = golden["feeds"].as_array().expect("feeds").iter().map(name).collect();
    for wanted in [
        "session-state",
        "session-state-steps",
        "live-turn",
        "live-turn-restored",
        "interleaved-deltas",
        "out-of-order-results",
        "aggregate-merges-restored",
        "aggregate-merges-live",
        "stop-during-tools",
        "history-reset",
        "approvals",
        "sections",
    ] {
        assert!(names.contains(&wanted), "no feed {wanted}");
    }
    assert!(names.iter().any(|n| n.starts_with("rows-golden/")), "the rows golden");
}
