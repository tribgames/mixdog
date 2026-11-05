//! The mock core serves the server's whole view of the core through `dyn CoreHandle`.

use std::sync::Arc;

use bytes::Bytes;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreHandle;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Feed;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::Window;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockCore;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::event;
use mixdog_core_api::ops::OpScope;
use mixdog_core_api::ops::OpStatus;
use mixdog_core_api::sink::ConnectionSink;
use serde_json::json;

#[tokio::test]
async fn mock_core_serves_every_seam() {
    let mock = MockCore::new(&["config"], MockLimits::default());
    let thread = mock.directory().insert(ThreadId::from("t1"));
    thread.set_active_turn(Some(TurnId::from("u1")));
    let core: &dyn CoreHandle = &mock;
    let ctx = CallContext::connection(ConnectionId(1), Default::default());

    let handle = core
        .threads()
        .open(&ThreadId::from("t1"), &ctx)
        .await
        .unwrap();
    assert!(matches!(
        core.threads().open(&ThreadId::from("nope"), &ctx).await,
        Err(CoreError::ThreadNotFound { .. })
    ));
    handle.interrupt(&TurnId::from("u1")).unwrap();
    assert!(matches!(
        handle.interrupt(&TurnId::from("old")),
        Err(CoreError::TurnNotActive { .. })
    ));

    let reply = core
        .domain("config")
        .unwrap()
        .call(CoreRequest {
            method: Method("config/read"),
            params: json!({"a": 1}),
            op: None,
            ctx: ctx.clone(),
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Value(v) if v["method"] == "config/read"));

    let status = core
        .ops()
        .status(
            &OpScope::Thread(ThreadId::from("t1")),
            &["op".into()],
            true,
            &ctx,
        )
        .await;
    assert_eq!(status.unwrap(), [OpStatus::NotApplied]);

    thread.feed().publish(&[event(1)], None).unwrap();
    let conn = MockConnection::new(ConnectionId(1), MockLimits::default());
    let source: Arc<dyn FeedSource> = handle.clone();
    let attached = subscribe(
        &source,
        SubscriptionId::from("s"),
        Window::LastItems(50),
        None,
        &conn,
    )
    .unwrap();
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    conn.send_control_release(Bytes::from_static(b"r"), attached.release)
        .unwrap();
    assert_eq!(conn.drain_text(), ["control:r", "s:snapshot@1"]);

    core.host_media()
        .frame(ConnectionId(1), Bytes::from_static(b"x"));
    assert_eq!(mock.media().frames().len(), 1);
    assert_eq!(
        *core.lifecycle().borrow(),
        mixdog_core_api::CoreState::Serving
    );
}
