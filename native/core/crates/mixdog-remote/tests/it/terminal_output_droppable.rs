//! Terminal output on the terminal lane reaches the relay marked droppable, as Node's `termData` did (remote-relay-push-lanes.ts:85,
//! recorded in apps/mobile/fixtures/terminal-lane-reach: every termData envelope `droppable: true`): the relay may skip it for a phone
//! that cannot take it instead of cutting the phone's leg. Every other frame, a tab's own feed included, is not droppable. The phone is
//! paired over a real E2EE channel through a scripted relay; the core's side of the bridge is the test's.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_remote::bridge::{DialError, Dialer, Frame, UpEvent, Upstream};
use mixdog_remote::identity::load_or_create_e2ee_identity;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, watch};

use crate::common;
use common::{driven_relay_with, on_lane, runtime_for};

const PHONE: &str = "p1";
const CRED: &str = "aaaaaaa1";
const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The core's socket to the bridge: what the test queued.
struct Core {
    queued: std::sync::Mutex<Option<mpsc::UnboundedReceiver<Frame>>>,
    dialed: watch::Sender<bool>,
}

struct CoreSocket(Mutex<mpsc::UnboundedReceiver<Frame>>);

#[async_trait]
impl Dialer for Core {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        let queued = self.queued.lock().unwrap().take().ok_or(DialError)?;
        self.dialed.send_replace(true);
        Ok(Box::new(CoreSocket(Mutex::new(queued))))
    }
}

#[async_trait]
impl Upstream for CoreSocket {
    async fn send(&mut self, _: Frame) -> Result<(), DialError> {
        Ok(())
    }
    async fn recv(&mut self) -> Option<UpEvent> {
        self.0.lock().await.recv().await.map(UpEvent::Frame)
    }
    async fn close(&mut self, _: u16) {}
}

/// A `process/outputDelta` as the core's feeds serialize it (`method` first, the feed's stamp last).
fn output(feed: &str, seq: u64) -> String {
    json!({ "method": "process/outputDelta", "params": { "processHandle": "term_1", "bytesB64": "eA==" }, "emittedAtMs": 1, "feed": { "id": feed, "epoch": 1, "seq": seq } })
        .to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_lane_output_goes_to_the_relay_droppable_and_nothing_else_does() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let relay = driven_relay_with(json!([{ "id": CRED, "name": "A" }]), true).await;
    let (to_bridge, queued) = mpsc::unbounded_channel();
    let (dialed, mut bridged) = watch::channel(false);
    let core = Arc::new(Core { queued: std::sync::Mutex::new(Some(queued)), dialed });
    let runtime = runtime_for(path, relay.port, core);
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
    runtime.list_clients().await.unwrap();
    let mut phone = relay.pair_phone(&identity, PHONE, CRED).await;
    tokio::time::timeout(WAIT, bridged.wait_for(|dialed| *dialed)).await.expect("the bridge dialed the core within 10 s").unwrap();

    let lane = output("process:relay", 1);
    let tab = output("process:term_1", 1);
    let other = json!({ "method": "thread/updated", "params": { "threadId": "t1" } }).to_string();
    for text in [&lane, &tab, &other] {
        to_bridge.send(Frame::Text(text.clone())).unwrap();
    }
    let mut got = Vec::new();
    for _ in 0..3 {
        got.push(tokio::time::timeout(WAIT, phone.recv_with_droppable()).await.expect("a frame reached the phone within 10 s"));
    }
    assert_eq!(got, vec![(lane, json!(true)), (tab, Value::Null), (other, Value::Null)]);
}
