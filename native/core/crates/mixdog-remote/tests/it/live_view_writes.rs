//! The live view's writes to a phone are asked about again where they enter the phone's stream: a browser frame or a WebRTC signal
//! the core queued before the phone's device was unpaired, and the bridge reads after it, reaches no phone, also one whose
//! connection the relay left open. The phone is paired over a real E2EE channel through a scripted relay that refuses the unpair;
//! the core's side of the bridge is the test's, which hands the bridge a frame only when the test lets it.

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

#[tokio::test(flavor = "multi_thread")]
async fn a_live_view_write_queued_before_an_unpair_reaches_no_phone() {
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

    // A frame and a WebRTC signal the core queued before the unpair, then a message of another kind.
    let signal = json!({ "method": "browser/webrtcSignal", "params": { "signal": { "type": "offer", "sdp": "v=0" } } }).to_string();
    let other = json!({ "method": "thread/updated", "params": { "threadId": "t1" } }).to_string();
    for text in [frame(2), signal, other.clone()] {
        to_bridge.send(Frame::Text(text)).unwrap();
    }
    // The unpair, which the relay refuses: the phone's connection stays open.
    let _ = runtime.revoke_client(CRED).await;
    // The bridge reads what was queued.
    reads.add_permits(3);
    assert_eq!(
        mixdog_rt::time::timeout(WAIT, phone.recv()).await.expect("a message reached the phone within 10 s"),
        other,
        "the frame and the signal queued before the unpair reached no phone"
    );
}
