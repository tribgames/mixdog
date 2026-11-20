//! The phones' browser streams as the desktop sees them: the view requests (`host/browser/viewFrames`) a phone's `browser/stream`
//! calls, a phone's unpair and the relay's close cause. Every assertion is on what the desktop was asked.

use mixdog_core_api::ConnectionNotifier;
use mixdog_core_api::call::CallContext;
use mixdog_protocol::Origin;

use super::tests::Scripted;
use super::tests::runtime;
use super::*;

struct Desktop(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl HostChannel for Desktop {
    async fn request(&self, _capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
        lock(&self.0).push((method.as_str().to_owned(), params));
        Ok(json!({}))
    }

    fn notify(&self, _capability: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
        lock(&self.0).push((method.as_str().to_owned(), params));
        Ok(())
    }
}

struct Phones;

impl ConnectionNotifier for Phones {
    fn notify(&self, _to: ConnectionId, _method: Method, _params: Value) -> Result<(), CoreError> {
        Ok(())
    }
}

fn service(desktop: &Arc<Desktop>, dir: &std::path::Path) -> LiveViewService {
    mixdog_rt::testing::tokens();
    LiveViewService::with_peers(
        desktop.clone(),
        Arc::new(Phones),
        HostMedia::new(1 << 20),
        runtime(dir),
        Arc::new(Scripted::default()),
        Arc::new(PairedScreenAccess::new(Arc::new(|_| None), Arc::new(|_| false), Arc::new(|_| true))),
    )
}

fn stream_call(connection: u64, on: bool) -> CoreRequest {
    let params = if on {
        json!({ "sessionId": "sess_1", "on": true, "request": { "maxWidth": 1170, "maxHeight": 2532 } })
    } else {
        json!({ "sessionId": "sess_1", "on": false })
    };
    CoreRequest {
        method: Method("browser/stream"),
        params,
        op: None,
        ctx: CallContext::connection(ConnectionId(connection), Origin::Relay, tokio_util::sync::CancellationToken::new()),
    }
}

fn view_requests(desktop: &Desktop) -> Vec<(bool, Value)> {
    lock(&desktop.0)
        .iter()
        .filter(|(method, _)| method == "host/browser/viewFrames")
        .map(|(_, params)| (params["on"] == json!(true), params["streamId"].clone()))
        .collect()
}

#[tokio::test]
async fn a_session_keeps_one_stream_number_from_its_first_viewer_to_its_last_and_the_last_one_stops_the_pictures() {
    let dir = tempfile::tempdir().unwrap();
    let desktop = Arc::new(Desktop(Mutex::default()));
    let service = service(&desktop, dir.path());
    service.call(stream_call(1, true)).await.unwrap();
    service.call(stream_call(2, true)).await.unwrap();
    let started = view_requests(&desktop);
    assert_eq!(started.len(), 2, "every subscription tells the desktop");
    assert!(started.iter().all(|(on, id)| *on && *id == started[0].1), "{started:?}");

    service.call(stream_call(1, false)).await.unwrap();
    assert!(view_requests(&desktop).iter().all(|(on, _)| *on), "a viewer remains, so the pictures go on");
    service.call(stream_call(2, false)).await.unwrap();
    let all = view_requests(&desktop);
    assert_eq!(all.last(), Some(&(false, started[0].1.clone())), "the last viewer's end stops the stream it started: {all:?}");
}

#[tokio::test]
async fn an_unpaired_viewer_stops_the_pictures_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let desktop = Arc::new(Desktop(Mutex::default()));
    let service = service(&desktop, dir.path());
    service.call(stream_call(1, true)).await.unwrap();
    service.unpaired(ConnectionId(1));
    assert_eq!(view_requests(&desktop).last().map(|(on, _)| *on), Some(false));
}

#[tokio::test]
async fn the_relay_closing_ends_every_stream() {
    let dir = tempfile::tempdir().unwrap();
    let desktop = Arc::new(Desktop(Mutex::default()));
    let service = service(&desktop, dir.path());
    service.call(stream_call(1, true)).await.unwrap();
    service.call(stream_call(2, true)).await.unwrap();
    service.relay_closed();
    assert_eq!(view_requests(&desktop).last().map(|(on, _)| *on), Some(false));
}
