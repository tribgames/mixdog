//! Node's completion routing of the inline host (`fixtures/inline-dispatch-cases`, `record-inline-dispatch-cases.mjs`:
//! "notifySessionCompletion routes to the runtime that owns the session, hinted or discovered",
//! `session-runtime-inline-host.dispatch.test.mjs:153`): each recorded `notifySessionCompletion(owner, text, meta)` through the
//! core's `OwnerNotify` (`SessionCompletions::notify` over the real `SessionDirectory`), the answer against Node's. An owner is a
//! started thread (Node: a runtime hinted by its id or found by `setSessionId`); a missing owner is a thread that was never
//! started; a disposed runtime's owner is a thread that was deleted (	hread/delete answered). The completions are plain text, as the test's.

use mixdog_core_session::session::agent_registry::SessionCompletions;
use mixdog_agent::agent_tool::flow::seams::OwnerNotify;

use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/inline-dispatch-cases/golden.json")).expect("json")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_recorded_completion_is_answered_as_in_node() {
    let golden = golden();
    let case = golden["cases"].as_array().unwrap().iter().find(|case| case["case"] == "notifySessionCompletion routes to the runtime that owns the session, hinted or discovered").expect("the case");
    // Named in the manifest: the host's close (the daemon's own lifetime).
    let excluded = ["after the host closed"];
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone()))));
    let completions = SessionCompletions::new(directory.clone());
    let start = |n: u32| {
        let directory = directory.clone();
        async move {
            let op = format!("op-start-{n}");
            let reply = directory.request(request("thread/start", json!({ "opId": op, "kind": "task", "projectPath": "/ws" }), &op)).await.expect("thread/start");
            let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
            subscribe.result["thread"]["id"].as_str().expect("thread id").to_owned()
        }
    };
    // The test's owners: the hinted runtime and the discovered one; the missing one never started.
    let owners = std::collections::HashMap::from([("sess_hint", start(1).await), ("sess_found", start(2).await), ("sess_missing", "never-started".to_owned())]);
    let mut answers = Vec::new();
    for call in case["recorded"]["answers"].as_array().unwrap() {
        let label = call["call"].as_str().unwrap();
        if excluded.contains(&label) {
            continue;
        }
        let owner = &owners[call["owner"].as_str().unwrap()];
        // The test's `hinted.dispose('bye')`: the owner's runtime ends the way a core thread's does, deleted (the catalog lists it, which a
        // delete needs).
        if label == "owner whose runtime was disposed" {
            rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
            let op = "op-dispose";
            let deleted = directory.request(request("thread/delete", json!({ "threadId": owner, "opId": op }), op)).await.expect("thread/delete");
            assert!(matches!(&deleted, Reply::Value(value) if *value == json!(true)), "the owner's thread was deleted: {deleted:?}");
        }
        let answer = completions.notify(owner, call["text"].as_str().unwrap(), &call["meta"]);
        answers.push(json!({ "call": label, "owner": call["owner"], "text": call["text"], "meta": call["meta"], "answer": answer }));
    }
    let want: Vec<Value> = case["recorded"]["answers"].as_array().unwrap().iter().filter(|call| !excluded.contains(&call["call"].as_str().unwrap())).cloned().collect();
    assert_eq!(answers, want, "{}", case["case"]);
}
