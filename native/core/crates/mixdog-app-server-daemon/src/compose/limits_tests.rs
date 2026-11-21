//! The core's wire limits are constructed once, by the composition: a value that is not the default reaches what the server
//! advertises at `initialize` AND what the workspace service states in a begin answer, because both are read from it.
#![allow(clippy::disallowed_methods, reason = "test setup")]
use super::*;
use std::time::Duration;

use mixdog_core_api::CoreHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;

async fn composed_with_non_default_limits() -> (tempfile::TempDir, Arc<ComposedCore>, Arc<mixdog_app_server::Outgoing>) {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let stop = mixdog_rt::CancellationToken::new();
    let outgoing = mixdog_app_server::Outgoing::new();
    // A chunk and a window that are not the defaults (193 536 and 3 MiB), and valid together: base64 of the chunk fits the frame
    // bound and the window holds one full encoded chunk.
    let limits = Limits { max_blob_put_chunk_bytes: 90_000, max_upload_in_flight_bytes: 1_000_000, ..Limits::default() };
    limits.check().expect("the test limits are valid");
    let core = mixdog_rt::time::timeout(
        Duration::from_secs(60),
        compose_with_limits(
            &tokens,
            ComposeConfig {
                outgoing: outgoing.clone(),
                ..tests::config_without_postgres(
                    &data,
                    dir.path(),
                    crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone()),
                    stop,
                    "the limits test must not install PostgreSQL",
                )
            },
            mixdog_rt::CancellationToken::new(),
            limits,
        ),
    )
    .await
    .expect("composition did not complete within 60 seconds")
    .unwrap();
    (dir, Arc::new(core), outgoing)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_default_limits_value_reaches_the_begin_answer() {
    let (_dir, core, _outgoing) = composed_with_non_default_limits().await;
    let begun = match core
        .domain_for("transfer/beginWrite")
        .expect("the workspace claims transfer/beginWrite")
        .call(CoreRequest {
            method: Method("transfer/beginWrite"),
            params: serde_json::json!({ "name": "a.bin", "size": 10, "scope": "draft1" }),
            op: None,
            ctx: CallContext::internal("limits-test"),
        })
        .await
        .expect("the begin is answered")
    {
        Reply::Value(value) => value,
        Reply::Subscribe(_) => panic!("unexpected subscribe"),
    };
    assert_eq!(begun["chunkBytes"], 90_000, "the begin answer states the composed chunk, not the default");
    mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("limits test")).await.expect("the core stopped within 30 seconds");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_default_limits_value_reaches_the_advertisement() {
    let (_dir, core, outgoing) = composed_with_non_default_limits().await;
    let running = crate::server::Running::build(core.clone(), outgoing).expect("the composed limits are valid");
    let wire = Arc::new(MockConnection::new(ConnectionId(1), MockLimits::default()));
    // The hub's first socket is connection 1: the server judges a call by the origin the hub holds for its connection.
    let _socket = running.hub.admit(mixdog_app_server_transport::ConnectionOrigin::Loopback);
    let handle = running.server.open(ConnectionId(1), wire.clone());
    let message = serde_json::from_value(serde_json::json!({
        "id": 0, "method": "initialize",
        "params": { "clientInfo": { "name": "test", "version": env!("CARGO_PKG_VERSION"), "kind": "desktop" }, "capabilities": {} },
    }))
    .expect("an initialize request");
    let _ = handle.on_message(message);
    let mut advertised = None;
    for _ in 0..5_000 {
        for written in wire.drain() {
            let frame: serde_json::Value = serde_json::from_slice(&written.frame).unwrap_or(serde_json::Value::Null);
            if frame["id"] == serde_json::json!(0) {
                assert!(frame["result"].is_object(), "initialize was refused: {frame}");
                advertised = Some(frame["result"]["limits"].clone());
            }
        }
        if advertised.is_some() {
            break;
        }
        tokio::task::yield_now().await;
        mixdog_rt::time::sleep(Duration::from_millis(1)).await;
    }
    let advertised = advertised.expect("initialize was answered");
    assert_eq!(advertised["maxBlobPutChunkBytes"], 90_000);
    assert_eq!(advertised["maxUploadInFlightBytes"], 1_000_000);
    assert_eq!(&serde_json::from_value::<Limits>(advertised).unwrap(), core.limits(), "the advertisement is the composed value");
    mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("limits test")).await.expect("the core stopped within 30 seconds");
}
