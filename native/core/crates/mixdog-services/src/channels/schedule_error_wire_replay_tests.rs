//! Replay of `native/core/fixtures/schedule-error-wire-cases` (`record-schedule-error-wire-cases.mjs`,
//! Node's `apps/desktop/src/main/schedule-error-wire.test.mjs`). The recorder threw each of the four
//! rename refusals at the daemon's call route (`scheduleNameTakenError('once-renamed')`,
//! `scheduleRenameRunningError('other')`, `scheduleRenameReloadError('once-renamed', 'timeout')`,
//! `scheduleRenameUncertainError('timeout')`); here the same refusals are the scheduler's
//! [`ScheduleError`]s, answered by the channel service's mapping ([`admin_error`], what
//! `channel/saveSchedule` returns) and compared with the body Node's daemon answered on the wire:
//! `{ error, code, details }`.
//! The desktop hops after the wire (the session client, the IPC envelope, the contextBridge clone,
//! the Korean page text) and Node's `/call` HTTP head are the desktop's, declared in the manifest.

use mixdog_core_api::CoreError;
use mixdog_protocol::DomainErrorDetail;
use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::admin::AdminError;
use super::service::admin_error;
use crate::scheduler::ScheduleError;

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

#[test]
fn every_schedule_rename_refusal_crosses_the_wire_with_its_code_and_name() {
    let golden = Exact::decode(&serde_json::from_str::<Value>(&GOLDEN).unwrap()).unwrap();
    let cases = golden.get("cases").as_array();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].get("case").as_str(), "every schedule rename refusal reaches the Schedules view translated, with its code and name");
    let results = cases[0].get("observed").get("results").as_array();
    // The recorder's four failures, in its order.
    let refusals = [
        ScheduleError::NameTaken { name: "once-renamed".into() },
        ScheduleError::RenameRunning { name: "other".into() },
        ScheduleError::RenameReloadFailed { name: "once-renamed".into(), cause: "timeout".into() },
        ScheduleError::RenameUncertain { cause: "timeout".into() },
    ];
    assert_eq!(results.len(), refusals.len());
    let got: Vec<Value> = refusals.into_iter().map(|refusal| wire_of_core(&admin_error(AdminError::Schedule(refusal)))).collect();
    let node: Vec<Value> = results.iter().map(node_wire).collect();
    assert_eq!(got, node);
}
