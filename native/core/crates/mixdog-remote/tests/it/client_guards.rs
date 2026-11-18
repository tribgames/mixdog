//! The two guards on an attached phone and the rule for a repeated `client-open`: an open of an
//! id that is already attached retires the first client (its bridged socket included), and a client whose end-to-end handshake does
//! not finish in 10 s is closed with "relay encryption handshake timed out".

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_remote::bridge::{DialError, Dialer, UpEvent, Upstream};
use mixdog_remote::identity::load_or_create_e2ee_identity;
use serde_json::json;

use crate::common;
use common::{Event, driven_relay, on_lane, runtime_for};

const CRED: &str = "aaaaaaa1";

/// Counts the sockets the bridge dialed and the ones it closed.
struct Counts {
    dialed: tokio::sync::watch::Sender<usize>,
    closed: tokio::sync::watch::Sender<usize>,
}

struct Core(Arc<Counts>);

struct CoreSocket(Arc<Counts>);

#[async_trait]
impl Dialer for Core {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        self.0.dialed.send_modify(|count| *count += 1);
        Ok(Box::new(CoreSocket(self.0.clone())))
    }
}

#[async_trait]
impl Upstream for CoreSocket {
    async fn send(&mut self, _: mixdog_remote::bridge::Frame) -> Result<(), DialError> {
        Ok(())
    }
    async fn recv(&mut self) -> Option<UpEvent> {
        std::future::pending().await
    }
    async fn close(&mut self, _: u16) {
        self.0.closed.send_modify(|count| *count += 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repeated_client_open_retires_the_first_clients_bridged_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let relay = driven_relay(json!([{ "id": CRED, "name": "A" }])).await;
    let counts = Arc::new(Counts { dialed: tokio::sync::watch::Sender::new(0), closed: tokio::sync::watch::Sender::new(0) });
    let runtime = runtime_for(path, relay.port, Arc::new(Core(counts.clone())));
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");

    let _phone = relay.pair_phone(&identity, "p1", CRED).await;
    counts.dialed.subscribe().wait_for(|count| *count == 1).await.expect("the bridge dialed the core");
    assert_eq!(*counts.closed.borrow(), 0, "the attached phone's socket is open");

    // The relay announces the same id again: the first client is retired, not left running beside the second.
    let again = relay.open_peer("p1", CRED);
    again.challenge().await;
    counts.closed.subscribe().wait_for(|count| *count == 1).await.expect("the first socket was closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_never_finishes_its_handshake_is_closed_after_ten_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let relay = driven_relay(json!([{ "id": CRED, "name": "A" }])).await;
    let counts = Arc::new(Counts { dialed: tokio::sync::watch::Sender::new(0), closed: tokio::sync::watch::Sender::new(0) });
    let runtime = runtime_for(dir.path().to_path_buf(), relay.port, Arc::new(Core(counts)));
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");

    let peer = relay.open_peer("slow", CRED);
    peer.challenge().await;
    // No hello follows. The next thing the PC does to this client is the close.
    let Event::Closed(reason) = peer.next().await else { panic!("the PC sent the silent client a frame instead of closing it") };
    assert_eq!(reason, "relay encryption handshake timed out");
}

/// The first open's 10 s deadline passes while a second open of the same id is waiting for its own handshake: it closes nothing (the
/// deadline belongs to the open it was armed for), and the second client is closed by its own deadline.
#[tokio::test(flavor = "multi_thread")]
async fn an_old_handshake_deadline_never_closes_the_client_that_replaced_it() {
    let dir = tempfile::tempdir().unwrap();
    let relay = driven_relay(json!([{ "id": CRED, "name": "A" }])).await;
    let counts = Arc::new(Counts { dialed: tokio::sync::watch::Sender::new(0), closed: tokio::sync::watch::Sender::new(0) });
    let runtime = runtime_for(dir.path().to_path_buf(), relay.port, Arc::new(Core(counts)));
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");

    let first = relay.open_peer("again", CRED);
    first.challenge().await;
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    let second = relay.open_peer("again", CRED);
    second.challenge().await;
    // The first deadline falls at 10 s, inside this window; the second one's at 16 s, after it.
    let quiet = tokio::time::timeout(std::time::Duration::from_secs(6), second.next()).await;
    assert!(quiet.is_err(), "the replaced open's deadline closed the client that replaced it");
    let Event::Closed(reason) = second.next().await else { panic!("the second client is closed by its own deadline") };
    assert_eq!(reason, "relay encryption handshake timed out");
}

/// A frame of an old open of an id, delivered after a replacement of the id has authenticated, is never sealed for the replacement: the
/// generation is checked where the channel that seals is chosen. The replacement's own frame (generation 1) reaches it.
#[tokio::test(flavor = "multi_thread")]
async fn an_old_opens_frame_is_never_sealed_for_the_replacement_that_authenticated() {
    use mixdog_remote::bridge::{Frame, PhoneSink, ToPhone};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let relay = driven_relay(json!([{ "id": CRED, "name": "A" }])).await;
    let counts = Arc::new(Counts { dialed: tokio::sync::watch::Sender::new(0), closed: tokio::sync::watch::Sender::new(0) });
    let runtime = runtime_for(path, relay.port, Arc::new(Core(counts.clone())));
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");

    let _first = relay.pair_phone(&identity, "p1", CRED).await;
    let mut second = relay.pair_phone(&identity, "p1", CRED).await;
    counts.dialed.subscribe().wait_for(|count| *count == 2).await.expect("the replacement was bridged");
    let sink = runtime.sink();
    sink.deliver(ToPhone::Frame { peer_id: "p1".into(), generation: 0, frame: Frame::Text("{\"old\":true}".into()) }).await;
    let quiet = tokio::time::timeout(std::time::Duration::from_millis(800), second.recv()).await;
    assert!(quiet.is_err(), "a frame of the old open was sealed for the replacement");
    sink.deliver(ToPhone::Frame { peer_id: "p1".into(), generation: 1, frame: Frame::Text("{\"new\":true}".into()) }).await;
    assert_eq!(second.recv().await, "{\"new\":true}");
}
