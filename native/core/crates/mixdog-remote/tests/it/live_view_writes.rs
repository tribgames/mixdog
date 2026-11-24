use std::sync::Arc;

use async_trait::async_trait;
use mixdog_remote::bridge::{DialError, Dialer, Frame, UpEvent, Upstream};
use mixdog_remote::identity::load_or_create_e2ee_identity;
use serde_json::json;
use tokio::sync::{Mutex, Semaphore, mpsc, watch};

use crate::common;
use common::{driven_relay_with, on_lane, runtime_for};

const PHONE: &str = "p1";
const CRED: &str = "aaaaaaa1";
const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The core's socket to the bridge: what the core queued, read by the bridge one frame per permit the test gives.
struct Core {
    queued: std::sync::Mutex<Option<mpsc::UnboundedReceiver<Frame>>>,
    reads: Arc<Semaphore>,
    dialed: watch::Sender<bool>,
}

struct CoreSocket {
    queued: Mutex<mpsc::UnboundedReceiver<Frame>>,
    reads: Arc<Semaphore>,
}

#[async_trait]
impl Dialer for Core {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        let queued = self.queued.lock().unwrap().take().ok_or(DialError)?;
        self.dialed.send_replace(true);
        Ok(Box::new(CoreSocket { queued: Mutex::new(queued), reads: self.reads.clone() }))
    }
}

#[async_trait]
impl Upstream for CoreSocket {
    async fn send(&mut self, _: Frame) -> Result<(), DialError> {
        Ok(())
    }
    async fn recv(&mut self) -> Option<UpEvent> {
        self.reads.acquire().await.ok()?.forget();
        self.queued.lock().await.recv().await.map(UpEvent::Frame)
    }
    async fn close(&mut self, _: u16) {}
}

fn frame(seq: u64) -> String {
    json!({ "method": "browser/frame", "params": { "sessionId": "sess_1", "seq": seq } }).to_string()
}

/// An unpair the relay refuses closes the phone and its socket to the core at once: the live-view writes the core queued before it
/// are never read, and the phone is told nothing but the close.
#[tokio::test(flavor = "multi_thread")]
async fn an_unpair_closes_the_phone_before_a_live_view_write_queued_for_it_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let relay = driven_relay_with(json!([{ "id": CRED, "name": "A" }]), false).await;
    let (to_bridge, queued) = mpsc::unbounded_channel();
    let reads = Arc::new(Semaphore::new(0));
    let (dialed, mut bridged) = watch::channel(false);
    let core = Arc::new(Core { queued: std::sync::Mutex::new(Some(queued)), reads: reads.clone(), dialed });
    let runtime = runtime_for(path, relay.port, core);
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
    runtime.list_clients().await.unwrap();
    let mut phone = relay.pair_phone(&identity, PHONE, CRED).await;
    mixdog_rt::time::timeout(WAIT, bridged.wait_for(|dialed| *dialed)).await.expect("the bridge dialed the core within 10 s").unwrap();

    // While the device may view, its frame reaches it.
    to_bridge.send(Frame::Text(frame(1))).unwrap();
    reads.add_permits(1);
    assert_eq!(mixdog_rt::time::timeout(WAIT, phone.recv()).await.expect("the first frame reached the phone within 10 s"), frame(1));

    // A frame and a WebRTC signal the core queued before the unpair, not yet read by the bridge.
    let signal = json!({ "method": "browser/webrtcSignal", "params": { "signal": { "type": "offer", "sdp": "v=0" } } }).to_string();
    for text in [frame(2), signal] {
        to_bridge.send(Frame::Text(text)).unwrap();
    }
    assert!(runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    // The close went out on the leg before the relay was asked.
    relay.frame(|frame| frame["type"] == "revoke-client").await;
    assert_eq!(phone.arrived().await, 1, "the close and nothing else reached the phone");
    assert_eq!(phone.closed().await, "relay encryption authentication failed");
    // The core's socket is gone with what it held: nothing queued before the unpair can be read for any phone.
    mixdog_rt::time::timeout(WAIT, to_bridge.closed()).await.expect("the unpair closed the phone's socket to the core within 10 s");
}
