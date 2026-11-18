//! The text of a failed exchange as the caller's kind of call words it: what a refused connection and an expired timer
//! read as on each surface, while the fault stays typed.

use std::time::Duration;

use mixdog_ai::transport::ABORTED;
use mixdog_ai::transport::CONNECTION_ERROR;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::FETCH_FAILED;
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::REQUEST_TIMED_OUT;
use mixdog_ai::transport::Redirect;
use mixdog_ai::transport::ReqwestLink;
use mixdog_ai::transport::SIGNAL_TIMED_OUT;
use mixdog_ai::transport::Surface;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_rt::Liveness;
use tokio::net::TcpListener;

#[test]
fn a_network_failure_reads_as_fetch_failed_on_every_raw_fetch_and_as_a_connection_error_on_an_sdk() {
    for surface in [Surface::Fetch, Surface::FetchSignal, Surface::FetchAborted, Surface::FetchLabeled("probe")] {
        assert_eq!(surface.connection_text(), Some(FETCH_FAILED), "{surface:?}");
    }
    assert_eq!(Surface::Sdk.connection_text(), Some(CONNECTION_ERROR));
    for surface in [Surface::Socket, Surface::SocketLabeled("probe"), Surface::SocketConnect] {
        assert_eq!(surface.connection_text(), None, "{surface:?}: a socket has no text of fetch's to give");
    }
    assert_eq!(FETCH_FAILED, "fetch failed");
    assert_eq!(CONNECTION_ERROR, "Connection error.");
}

#[test]
fn an_expired_timer_reads_as_the_calls_own_timeout() {
    let after = Duration::from_millis(1500);
    assert_eq!(Surface::Fetch.timeout_text(after).as_deref(), Some("fetch failed"), "a missed headers timeout is a fetch failure");
    assert_eq!(Surface::FetchSignal.timeout_text(after).as_deref(), Some(SIGNAL_TIMED_OUT));
    assert_eq!(Surface::FetchAborted.timeout_text(after).as_deref(), Some(ABORTED));
    assert_eq!(Surface::FetchLabeled("catalog read").timeout_text(after).as_deref(), Some("catalog read timed out after 1500ms"), "the label and the timer in milliseconds");
    assert_eq!(Surface::SocketLabeled("stream").timeout_text(Duration::from_secs(2)).as_deref(), Some("stream timed out after 2000ms"));
    assert_eq!(Surface::Sdk.timeout_text(after).as_deref(), Some(REQUEST_TIMED_OUT));
    assert_eq!(Surface::SocketConnect.timeout_text(after).as_deref(), Some("Cursor stream was aborted"));
    assert_eq!(Surface::Socket.timeout_text(after), None);
    assert_eq!(SIGNAL_TIMED_OUT, "The operation was aborted due to timeout");
    assert_eq!(ABORTED, "This operation was aborted");
    assert_eq!(REQUEST_TIMED_OUT, "Request timed out.");
}

#[test]
fn a_failure_text_falls_back_to_the_links_own_only_where_the_surface_has_none() {
    assert_eq!(Surface::Fetch.text(|| "own".to_owned()), "fetch failed");
    assert_eq!(Surface::Sdk.text(|| "own".to_owned()), "Connection error.");
    assert_eq!(Surface::Socket.text(|| "own".to_owned()), "own");
    assert_eq!(Surface::SocketConnect.text(|| "own".to_owned()), "own");
}

async fn refused(surface: Surface, url: String) -> ProviderError {
    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap();
    let exchange = Exchange::new(Liveness::unary(Duration::from_secs(60)), Redirect::Follow, surface);
    link.send(WireRequest { transport: TransportKind::Http1, method: "GET".into(), url, headers: Vec::new(), body: Vec::new() }, exchange)
        .await
        .err()
        .expect("nothing listens there")
}

#[tokio::test]
async fn a_refused_connection_is_a_typed_connect_fault_worded_for_the_surface() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    drop(listener);
    let (fetch, sdk) = tokio::join!(refused(Surface::Fetch, url.clone()), refused(Surface::Sdk, url));
    for error in [&fetch, &sdk] {
        assert!(matches!(error.transport, Some(TransportFault::Connect { .. })), "{error:?}");
    }
    assert_eq!(fetch.message, "fetch failed");
    assert_eq!(sdk.message, "Connection error.");
}
