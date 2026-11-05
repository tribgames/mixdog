use std::sync::Mutex;

use mixdog_core_api::ids::ConnectionId;
use serde_json::json;

use super::*;
use crate::domains::support::testing::request;

#[derive(Default)]
struct Recorder {
    inputs: Mutex<Vec<i64>>,
    lines: Mutex<Vec<String>>,
}

impl AppInputSink for Recorder {
    fn note_user_input(&self, at_ms: i64) {
        self.inputs.lock().unwrap().push(at_ms);
    }
}

impl PerfSink for Recorder {
    fn line(&self, line: &str) {
        self.lines.lock().unwrap().push(line.to_owned());
    }
}

fn rig() -> (Arc<ClientService>, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::default());
    (ClientService::new(recorder.clone(), recorder.clone()), recorder)
}

fn send(service: &ClientService, method: &'static str, params: Value) -> Admit {
    service.notify(Method(method), params, ConnectionId(1))
}

#[test]
fn activity_reaches_the_heartbeat_and_perf_lines_reach_the_sink() {
    let (service, recorder) = rig();
    assert!(matches!(send(&service, "client/activity", json!({ "at": 1_793_306_570_000i64 })), Admit::Accepted));
    assert!(matches!(send(&service, "client/perfLog", json!({ "line": "boot 120ms" })), Admit::Accepted));
    assert_eq!(*recorder.inputs.lock().unwrap(), vec![1_793_306_570_000]);
    assert_eq!(*recorder.lines.lock().unwrap(), vec!["boot 120ms".to_owned()]);
}

#[test]
fn a_time_that_is_not_positive_and_params_that_do_not_decode_are_dropped() {
    let (service, recorder) = rig();
    for params in [json!({ "at": 0 }), json!({ "at": -5 }), json!({ "at": "now" }), json!({}), json!(null)] {
        assert!(matches!(send(&service, "client/activity", params), Admit::Accepted));
    }
    assert!(matches!(send(&service, "client/perfLog", json!({ "line": 5 })), Admit::Accepted));
    assert!(recorder.inputs.lock().unwrap().is_empty());
    assert!(recorder.lines.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_namespace_has_no_requests() {
    let (service, _) = rig();
    assert!(matches!(
        service.call(request("client/activity", json!({ "at": 1 }), None)).await,
        Err(CoreError::InvalidParams { .. })
    ));
}
