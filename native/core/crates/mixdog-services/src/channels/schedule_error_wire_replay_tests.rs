//! Replay of `native/core/fixtures/schedule-error-wire-cases` (`record-schedule-error-wire-cases.mjs`,
//! Node's `apps/desktop/src/main/schedule-error-wire.test.mjs`). The recorder threw each rename
//! refusal at the daemon's call route for the desktop's `saveSchedule({ name: 'other', newName:
//! 'once-renamed' })`; here the core's engine refuses that rename itself: the real `channel/saveSchedule`
//! over the real stores, scheduler and runtime, each refusal's state reached as production reaches it:
//! - `SCHEDULE_NAME_TAKEN`: `once-renamed` is saved already;
//! - `SCHEDULE_RENAME_RUNNING`: a run of `other` holds its name;
//! - `SCHEDULE_RENAME_RELOAD_FAILED`: the runtime is up and the reload that arms the new name fails (`timeout`).
//!
//! What the call answers is compared with the body Node's daemon answered on the wire
//! (`{ error, code, details }`). The rename carries what a save requires besides the recorded names
//! (`instructions`, `time`, `overwrite`, as the Schedules view sends them); `SCHEDULE_RENAME_UNCERTAIN`
//! has no path in the core (Node raises it when the session runtime's call to the channel worker
//! process fails, `channel-config-api.mjs:63`; the core's admin calls its scheduler in process).
//! Both, and the desktop hops after the wire, are declared in the manifest.

use mixdog_core_api::CoreError;
use mixdog_protocol::DomainErrorDetail;
use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::tests_runtime::{Env, ask, env, service};
use super::tools::ChannelLifecycle;
use crate::bots::RoutineKind;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/schedule-error-wire-cases/golden.json");

/// The refusal as the core answers it on the wire: its message, its code, and the public detail.
fn wire_of_core(error: &CoreError) -> Value {
    let CoreError::DomainError { code, message, detail, .. } = error else { panic!("a domain refusal, not {error:?}") };
    let mut wire = json!({"error": message.as_deref().unwrap_or_default()});
    if let Some(code) = code {
        wire["code"] = json!(code.as_ref());
    }
    if let Some(detail) = detail {
        let name = match &**detail {
            DomainErrorDetail::ScheduleNameTaken { name } | DomainErrorDetail::ScheduleRenameRunning { name } | DomainErrorDetail::ScheduleRenameReloadFailed { name } => name,
            other => panic!("not a schedule detail: {other:?}"),
        };
        wire["details"] = json!({"name": name});
    }
    wire
}

/// The body Node's daemon answered the `/call` with (`call-route.mjs`: `{ error: message, code?, details? }`),
/// as recorded on the wire.
fn node_wire(result: &Exact) -> Value {
    let wire = result.get("wire").as_array();
    let answer = wire.iter().find(|hop| hop.get("direction").as_str() == "daemon->client").expect("the daemon's answer");
    serde_json::from_str(answer.get("text").as_str()).expect("a JSON body")
}

/// The recorded call's entry (`args[1][0]` of `desktop.invoke`).
fn recorded_entry(result: &Exact) -> Value {
    let request = result.get("wire").as_array()[0].get("request").get("body").get("args").to_plain().unwrap();
    request["args"][1][0].clone()
}

/// A schedule as the Schedules view saves it.
fn saved(name: &str) -> Value {
    json!({"name": name, "time": "0 9 * * *", "instructions": "Report."})
}

/// The desktop's rename of `entry` (the recorded names) with what a save requires besides them.
fn rename_of(entry: &Value) -> Value {
    let mut rename = saved(entry["name"].as_str().expect("the recorded name"));
    rename["newName"] = entry["newName"].clone();
    rename["overwrite"] = json!(true);
    rename
}

async fn save(e: &Env, entry: Value) -> Result<Value, CoreError> {
    ask(&service(e), "channel/saveSchedule", json!({ "entry": entry })).await
}

/// The rename refused by the engine in the state `code` names; what `channel/saveSchedule` answers.
async fn refused(code: &str, entry: &Value) -> Value {
    let e = env().await;
    let old = entry["name"].as_str().expect("the recorded name");
    save(&e, saved(old)).await.expect("the schedule saves");
    let _held = match code {
        "SCHEDULE_NAME_TAKEN" => {
            save(&e, saved(entry["newName"].as_str().expect("the recorded new name"))).await.expect("the other schedule saves");
            None
        }
        "SCHEDULE_RENAME_RUNNING" => Some(e.routines.runs().begin(RoutineKind::Schedule, old).expect("a run of the schedule starts")),
        "SCHEDULE_RENAME_RELOAD_FAILED" => {
            e.runtime.start_automation().await.expect("the runtime starts");
            *e.services.reload_fails.lock().unwrap() = Some("timeout".into());
            None
        }
        other => panic!("no state reaches {other}"),
    };
    let error = save(&e, rename_of(entry)).await.expect_err("the engine refuses the rename");
    if e.runtime.automation_running() {
        e.runtime.stop_owned_runtime("replay").await.expect("the runtime stops");
    }
    wire_of_core(&error)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_schedule_rename_refusal_crosses_the_wire_with_its_code_and_name() {
    let golden = Exact::decode(&serde_json::from_str::<Value>(&GOLDEN).unwrap()).unwrap();
    let cases = golden.get("cases").as_array();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].get("case").as_str(), "every schedule rename refusal reaches the Schedules view translated, with its code and name");
    let results = cases[0].get("observed").get("results").as_array();
    assert_eq!(results.len(), 4);
    let (mut got, mut node) = (Vec::new(), Vec::new());
    for result in results {
        let wire = node_wire(result);
        let code = wire["code"].as_str().expect("a coded refusal");
        // Declared in the manifest: the core has no path to an uncertain rename.
        if code == "SCHEDULE_RENAME_UNCERTAIN" {
            continue;
        }
        got.push(refused(code, &recorded_entry(result)).await);
        node.push(wire);
    }
    assert_eq!(got, node);
}
