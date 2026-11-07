//! A connection that ends is reported to the core once (`CoreHandle::connection_closed`), whichever way it ended.

use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::Origin;

use super::Rig;

#[tokio::test]
async fn each_connection_is_reported_closed_once_when_its_handle_drops() {
    let rig = Rig::new();
    let (a, b) = (rig.connect(1, Origin::Local), rig.connect(2, Origin::Local));
    assert!(rig.core.mock.closed_connections().is_empty(), "open connections are not reported");
    drop(a);
    assert_eq!(rig.core.mock.closed_connections(), vec![ConnectionId(1)]);
    drop(b);
    assert_eq!(rig.core.mock.closed_connections(), vec![ConnectionId(1), ConnectionId(2)]);
}

#[tokio::test]
async fn a_connection_the_server_ended_itself_is_still_reported_once() {
    let rig = Rig::new();
    let client = rig.connect(7, Origin::Local);
    // An unparseable frame ends the connection (P §3); the drive loop then drops the handle.
    assert!(matches!(client.handle.on_text("this is not json"), crate::Inbound::Close(_)));
    assert!(rig.core.mock.closed_connections().is_empty(), "the close is reported when the handle drops, not when the server decides");
    drop(client);
    assert_eq!(rig.core.mock.closed_connections(), vec![ConnectionId(7)]);
}