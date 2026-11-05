//! Dispatch from the generated method table: routing, keys, origin rules, the shape checks
//! and the lifecycle gate.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreState;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ops::OpScope;
use mixdog_core_api::ops::OpStatus;
use mixdog_protocol::DrainReason;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;

use super::Rig;
use super::reason;
use super::sample::Samples;
use super::settle;

/// Methods the server answers itself instead of passing to the core.
const HANDLED_HERE: [&str; 8] = [
    "initialize",
    "app/subscribe",
    "feed/unsubscribe",
    "thread/unsubscribe",
    "op/status",
    "turn/interrupt",
    "turn/steer",
    "host/claim",
];

#[tokio::test]
async fn every_method_of_the_table_dispatches_to_the_mock_core() {
    let rig = Rig::new();
    rig.core.mock.directory().insert(ThreadId::from("x"));
    let client = rig.ready(1, json!({}));
    let samples = Samples::new();
    let mut failures = Vec::new();
    let mut dispatched = 0;
    for (index, spec) in CLIENT_METHODS.iter().enumerate() {
        if HANDLED_HERE.contains(&spec.method) {
            continue;
        }
        let id = index as i64 + 1;
        let params = samples.params(spec.method);
        client.request(id, spec.method, params.clone());
        let response = client.response(id).await;
        if !spec.allows(Origin::Local) {
            if reason(&response) != "permissionDenied" {
                failures.push(format!("{}: expected permissionDenied: {response}", spec.method));
            }
        } else if response["result"]["method"] != json!(spec.method)
            || response["result"]["params"] != params
        {
            failures.push(format!("{}: {response}", spec.method));
        } else {
            dispatched += 1;
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    assert!(dispatched > 400, "only {dispatched} methods reached the core");
}

#[tokio::test]
async fn a_request_naming_a_thread_goes_to_that_thread_and_others_to_the_directory() {
    let rig = Rig::new();
    let thread = rig.core.mock.directory().insert(ThreadId::from("t1"));
    thread.set_handler(Arc::new(|_| Ok(Reply::Value(json!({ "via": "thread" })))));
    rig.core
        .mock
        .directory()
        .set_handler(Arc::new(|_| Ok(Reply::Value(json!({ "via": "directory" })))));
    let client = rig.ready(1, json!({}));
    client.request(1, "thread/read", json!({ "threadId": "t1" }));
    assert_eq!(client.response(1).await["result"], json!({ "via": "thread" }));
    client.request(2, "thread/list", json!({}));
    assert_eq!(client.response(2).await["result"], json!({ "via": "directory" }));
    client.request(3, "thread/read", json!({ "threadId": "missing" }));
    let missing = client.response(3).await;
    assert_eq!(reason(&missing), "threadNotFound");
    assert_eq!(missing["error"]["data"]["threadId"], json!("missing"));
}

#[tokio::test]
async fn mutations_carry_their_op_id_to_the_core() {
    let rig = Rig::new();
    type Seen = Arc<Mutex<Vec<(String, Option<OpId>)>>>;
    let seen: Seen = Arc::default();
    let record = seen.clone();
    rig.core.mock.directory().set_handler(Arc::new(move |req| {
        record
            .lock()
            .unwrap()
            .push((req.method.to_string(), req.op.clone()));
        Ok(Reply::Value(json!({})))
    }));
    let client = rig.ready(1, json!({}));
    let params = Samples::new().params("thread/start");
    assert_eq!(params["opId"], json!("x"));
    client.request(1, "thread/start", params);
    client.response(1).await;
    client.request(2, "thread/list", json!({}));
    client.response(2).await;
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            ("thread/start".to_owned(), Some(OpId::from("x"))),
            ("thread/list".to_owned(), None)
        ]
    );
}

#[tokio::test]
async fn shape_rules_hold_for_every_method() {
    let rig = Rig::new();
    rig.core.mock.directory().insert(ThreadId::from("t1"));
    let client = rig.ready(1, json!({}));

    // A mutation without an op id.
    client.request(1, "thread/name/set", json!({ "threadId": "t1", "name": "n" }));
    let missing = client.response(1).await;
    assert_eq!(reason(&missing), "opIdRequired");
    assert_eq!(missing["error"]["code"], json!(-32602));

    // A caller-supplied host field.
    client.request(2, "thread/list", json!({ "device": "my pc" }));
    let device = client.response(2).await;
    assert_eq!(reason(&device), "invalidParams");
    assert_eq!(device["error"]["data"]["path"], json!("device"));
}

#[tokio::test]
async fn origin_rules_come_from_the_table() {
    let rig = Rig::new();
    let phone = rig.connect(1, Origin::Relay);
    phone.initialize(super::VERSION, json!({}));
    phone.response(0).await;
    // `thread/resume` is not offered over the relay.
    phone.request(
        1,
        "thread/resume",
        json!({ "threadId": "t1", "window": { "lastItems": 10 } }),
    );
    let denied = phone.response(1).await;
    assert_eq!(reason(&denied), "permissionDenied");
    assert_eq!(
        denied["error"]["data"],
        json!({ "reason": "permissionDenied", "method": "thread/resume", "origin": "relay" })
    );
    phone.request(2, "thread/list", json!({}));
    assert!(phone.response(2).await.get("result").is_some());
}

#[tokio::test]
async fn the_lifecycle_gates_new_work_but_not_controls() {
    let rig = Rig::new();
    let client = rig.ready(1, json!({}));
    let mock = &rig.core.mock;

    mock.set_state(CoreState::Migrating(mixdog_core_api::handle::MigrationProgress {
        kind: "sessions".into(),
        done: 2,
        total: 5,
    }));
    client.request(1, "thread/list", json!({}));
    let migrating = client.response(1).await;
    assert_eq!(
        migrating["error"]["data"],
        json!({ "reason": "coreMigrating", "kind": "sessions", "done": 2, "total": 5 })
    );
    client.request(2, "op/status", json!({ "scope": "config", "opIds": [], "fence": false }));
    assert!(client.response(2).await.get("result").is_some());

    mock.set_state(CoreState::Draining {
        reason: DrainReason::Update,
    });
    let touch = Samples::new().params("project/touch");
    client.request(3, "project/touch", touch);
    let draining = client.response(3).await;
    assert_eq!(
        draining["error"]["data"],
        json!({ "reason": "serverShuttingDown", "drainReason": "update" })
    );
    client.request(4, "project/list", json!({}));
    assert!(client.response(4).await.get("result").is_some(), "reads continue");
}

#[tokio::test]
async fn an_answer_racing_the_connection_close_is_not_sent() {
    let rig = Rig::new();
    rig.core
        .mock
        .directory()
        .set_handler(Arc::new(|_| Err(CoreError::ConnectionClosed)));
    let client = rig.ready(1, json!({}));
    client.request(1, "thread/list", json!({}));
    settle().await;
    assert!(client.drain().is_empty());
}

#[tokio::test]
async fn op_status_answers_from_the_op_index_per_scope() {
    let rig = Rig::new();
    let index = rig.core.mock.op_index();
    index.set(
        OpScope::Thread(ThreadId::from("t1")),
        OpId::from("a"),
        OpStatus::Applied {
            seq: Some(7),
            result: Some(json!({ "ok": true })),
        },
    );
    index.set(
        OpScope::Domain("config".into()),
        OpId::from("b"),
        OpStatus::Rejected {
            error: CoreError::OpIdConflict {
                op_id: OpId::from("b"),
            },
        },
    );
    let client = rig.ready(1, json!({}));
    client.request(
        1,
        "op/status",
        json!({ "scope": "thread:t1", "opIds": ["a", "zz"], "fence": true }),
    );
    let response = client.response(1).await;
    assert_eq!(
        response["result"],
        json!({ "ops": [
            { "opId": "a", "state": "applied", "seq": 7, "result": { "ok": true } },
            { "opId": "zz", "state": "notApplied" },
        ]})
    );
    client.request(
        2,
        "op/status",
        json!({ "scope": "config", "opIds": ["b"], "fence": false }),
    );
    let rejected = client.response(2).await;
    let state = &rejected["result"]["ops"][0];
    assert_eq!(state["state"], json!("rejected"));
    assert_eq!(state["error"]["code"], json!(-32602));
    assert_eq!(state["error"]["data"]["reason"], json!("opIdConflict"));
}

// ---- serialization through the server

fn touch(samples: &Samples, op: &str) -> Value {
    let mut params = samples.params("project/touch");
    params["opId"] = json!(op);
    params
}

#[tokio::test]
async fn requests_of_one_key_run_one_at_a_time_and_other_keys_run_beside_them() {
    let rig = Rig::gated(&["terminal"]);
    let client = rig.ready(1, json!({}));
    let gate = rig.gate("terminal");
    let focus = |id: i64, tab: &str| client.request(id, "terminal/focus", json!({ "tabId": tab }));
    focus(1, "a");
    focus(2, "a");
    focus(3, "b");
    settle().await;
    // `a` #2 waits for `a` #1; `b` runs beside `a`.
    let mut started = gate.log();
    started.sort();
    assert_eq!(started, ["start terminal/focus:a", "start terminal/focus:b"]);
    gate.permits.add_permits(3);
    client.frames(3).await;
    let log = gate.log();
    let a_ends = log
        .iter()
        .enumerate()
        .filter(|(_, l)| *l == "end terminal/focus:a")
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    let a_starts = log
        .iter()
        .enumerate()
        .filter(|(_, l)| *l == "start terminal/focus:a")
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    assert_eq!((a_starts.len(), a_ends.len()), (2, 2));
    assert!(a_ends[0] < a_starts[1], "second `a` started before the first ended: {log:?}");
}

#[tokio::test]
async fn reads_share_a_domain_and_queue_behind_its_writes() {
    let rig = Rig::gated(&["project"]);
    let client = rig.ready(1, json!({}));
    let gate = rig.gate("project");
    let samples = Samples::new();
    client.request(1, "project/touch", touch(&samples, "w1"));
    client.request(2, "project/list", json!({}));
    client.request(3, "project/list", json!({}));
    settle().await;
    assert_eq!(gate.log(), ["start project/touch:w1"], "reads wait for the write");
    gate.permits.add_permits(1);
    settle().await;
    // The write ended; both reads started together.
    assert_eq!(
        gate.log()[1..],
        [
            "end project/touch:w1",
            "start project/list:",
            "start project/list:"
        ]
    );
    gate.permits.add_permits(2);
    client.frames(3).await;
}

#[tokio::test]
async fn queued_requests_of_a_closed_connection_never_run() {
    let rig = Rig::gated(&["project"]);
    let samples = Samples::new();
    let gate = rig.gate("project");
    {
        let client = rig.ready(1, json!({}));
        client.request(1, "project/touch", touch(&samples, "w1"));
        client.request(2, "project/touch", touch(&samples, "w2"));
        settle().await;
        assert_eq!(gate.log(), ["start project/touch:w1"]);
    }
    // The connection is gone: the running request finishes, the queued one is discarded.
    gate.permits.add_permits(2);
    settle().await;
    assert_eq!(gate.log(), ["start project/touch:w1", "end project/touch:w1"]);
    let other = rig.ready(2, json!({}));
    other.request(1, "project/touch", touch(&samples, "w3"));
    settle().await;
    assert_eq!(gate.log()[2], "start project/touch:w3");
}
