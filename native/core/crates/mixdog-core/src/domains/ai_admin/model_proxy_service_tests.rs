//! The model proxy over the connection: the server end through the host channel, the PC end as a
//! domain service answering one connection.

use std::sync::Mutex;

use mixdog_core_api::domain::mock::MockAttempt;
use mixdog_core_api::mock::MockHostChannel;
use mixdog_protocol::Origin;

use super::*;
use crate::domains::ai_admin::model_proxy::request_out;
use crate::domains::ai_admin::model_proxy::tests::{hi, loopback};

fn usable() -> Value {
    json!({ "call": { "method": "quotaUsable", "provider": "p", "model": "m" } })
}

async fn execute(host: &Arc<MockHostChannel>, events: &mut Vec<Value>) -> Result<Value, ProxyError> {
    let transport = HostProxyTransport { host: host.clone() };
    transport.execute(usable()["call"].clone(), &mut |e| events.push(e), &CancellationToken::new()).await
}

#[tokio::test]
async fn the_server_end_gets_events_then_the_answer() {
    let host = Arc::new(MockHostChannel::default());
    host.claim(HostCapability::ModelProxy);
    host.stream(EXECUTE, vec![json!({ "type": "textDelta", "text": "a" })]);
    host.reply(EXECUTE, json!({ "result": { "result": "usable", "usable": true } }));
    let mut events = Vec::new();
    assert_eq!(execute(&host, &mut events).await, Ok(json!({ "result": "usable", "usable": true })));
    assert_eq!(events, vec![json!({ "type": "textDelta", "text": "a" })]);
    assert_eq!(host.sent()[0].2, usable());
}

#[tokio::test]
async fn a_failure_comes_back_whether_it_is_a_result_or_a_rpc_error() {
    let host = Arc::new(MockHostChannel::default());
    host.claim(HostCapability::ModelProxy);
    host.reply(EXECUTE, json!({ "result": { "result": "failed", "failure": { "message": "no" } } }));
    assert_eq!(execute(&host, &mut Vec::new()).await, Err(ProxyError::Remote(json!({ "message": "no" }))));
    host.fail(EXECUTE, -32603, "boom", Some(json!({ "message": "data" })));
    assert_eq!(execute(&host, &mut Vec::new()).await, Err(ProxyError::Remote(json!({ "message": "data" }))));
    host.fail(EXECUTE, -32603, "boom", None);
    assert_eq!(execute(&host, &mut Vec::new()).await, Err(ProxyError::Remote(json!("boom"))));
}

#[tokio::test]
async fn without_a_proxy_connection_the_call_is_unavailable_and_a_cancel_ends_it() {
    let host = Arc::new(MockHostChannel::default());
    assert_eq!(execute(&host, &mut Vec::new()).await, Err(ProxyError::Unavailable));
    let transport = HostProxyTransport { host: host.clone() };
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(transport.execute(Value::Null, &mut |_| {}, &cancel).await, Err(ProxyError::Cancelled));
}

#[derive(Default)]
struct Notes(Mutex<Vec<(ConnectionId, String, Value)>>);

impl ConnectionNotifier for Notes {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        self.0.lock().unwrap().push((to, method.as_str().to_owned(), params));
        Ok(())
    }
}

async fn service(attempts: Vec<MockAttempt>) -> (ModelProxyService, Arc<Notes>) {
    let notes = Arc::new(Notes::default());
    let runner = Arc::new(loopback(attempts).await.0);
    (ModelProxyService::new(runner, Arc::new(MockHostChannel::default()), notes.clone()), notes)
}

fn run(provider: &str, id: u64) -> CoreRequest {
    let call = w::ProxyCall::Send { provider: provider.into(), request: Box::new(request_out(&hi())) };
    CoreRequest {
        method: Method(RUN),
        params: json!({ "runId": "r1", "call": call }),
        op: None,
        ctx: mixdog_core_api::CallContext::connection(ConnectionId(id), Origin::Local, CancellationToken::new()),
    }
}

#[tokio::test]
async fn a_run_streams_its_events_to_the_asking_connection_and_answers() {
    let (service, notes) = service(vec![MockAttempt::Body(b"t:hi\ndone\n".to_vec())]).await;
    let Reply::Value(answer) = service.call(run("mock", 7)).await.unwrap() else { panic!("not a value") };
    assert_eq!(answer["result"]["result"], json!("sent"));
    let notes = notes.0.lock().unwrap();
    assert!(!notes.is_empty());
    for (to, method, params) in notes.iter() {
        assert_eq!((*to, method.as_str(), params["runId"].as_str()), (ConnectionId(7), "modelProxy/run/event", Some("r1")));
    }
}

#[tokio::test]
async fn a_failed_run_is_a_result_and_a_run_needs_a_connection() {
    let (service, _) = service(Vec::new()).await;
    let Reply::Value(answer) = service.call(run("absent", 7)).await.unwrap() else { panic!("not a value") };
    assert_eq!(answer["result"]["result"], json!("failed"));
    let mut internal = run("mock", 7);
    internal.ctx = mixdog_core_api::CallContext::internal("test");
    assert!(matches!(service.call(internal).await, Err(CoreError::InvalidParams { .. })));
}

#[test]
fn events_reach_the_host_channel_by_request_id() {
    struct Seen(Mutex<Vec<(ConnectionId, Value, Value)>>);
    #[async_trait]
    impl HostChannel for Seen {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!()
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            unreachable!()
        }
        fn stream_event(&self, from: ConnectionId, request: &Value, event: Value) -> bool {
            self.0.lock().unwrap().push((from, request.clone(), event));
            true
        }
    }
    let seen = Arc::new(Seen(Mutex::default()));
    let runner = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(loopback(Vec::new())).0;
    let service = ModelProxyService::new(Arc::new(runner), seen.clone(), Arc::new(Notes::default()));
    let admit = service.notify(Method(EVENT), json!({ "requestId": "host-1", "event": { "n": 1 } }), ConnectionId(3));
    assert!(matches!(admit, Admit::Accepted));
    assert_eq!(*seen.0.lock().unwrap(), vec![(ConnectionId(3), json!("host-1"), json!({ "n": 1 }))]);
}

#[tokio::test]
async fn a_cancel_stops_only_the_named_run_of_the_asking_connection() {
    let (service, _) = service(Vec::new()).await;
    let mine = CancellationToken::new();
    let other_run = CancellationToken::new();
    let other_connection = CancellationToken::new();
    {
        let mut runs = service.runs.lock().unwrap();
        runs.insert((ConnectionId(7), "r1".into()), mine.clone());
        runs.insert((ConnectionId(7), "r2".into()), other_run.clone());
        runs.insert((ConnectionId(8), "r1".into()), other_connection.clone());
    }
    service.notify(Method(CANCEL), json!({ "runId": "r1" }), ConnectionId(7));
    assert!((mine.is_cancelled(), other_run.is_cancelled(), other_connection.is_cancelled()) == (true, false, false));
}
