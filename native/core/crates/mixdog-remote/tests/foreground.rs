//! A phone's account of its own screen (`setForeground`, `setScreenSessions`), carried over a real
//! E2EE channel through a scripted relay, decides `is_client_foreground`; the reports are not
//! forwarded to the core. `paired_devices` lists the credentials the relay reported.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_remote::bridge::{DialError, Dialer, Frame, UpEvent, Upstream};
use mixdog_remote::identity::load_or_create_e2ee_identity;
use serde_json::{Value, json};

mod common;
use common::{driven_relay, eventually, on_lane, runtime_for};

const PHONE: &str = "p1";
const CRED_A: &str = "aaaaaaa1";
const CRED_B: &str = "bbbbbbb2";

type Forwarded = Arc<Mutex<Vec<Frame>>>;

struct Core(Forwarded);

struct CoreSocket(Forwarded);

#[async_trait]
impl Dialer for Core {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        Ok(Box::new(CoreSocket(self.0.clone())))
    }
}

#[async_trait]
impl Upstream for CoreSocket {
    async fn send(&mut self, frame: Frame) -> Result<(), DialError> {
        self.0.lock().unwrap().push(frame);
        Ok(())
    }
    async fn recv(&mut self) -> Option<UpEvent> {
        std::future::pending().await
    }
    async fn close(&mut self, _: u16) {}
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_reporting_its_screen_decides_foreground_and_is_not_forwarded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let relay = driven_relay(json!([{ "id": CRED_B, "name": "B" }, { "id": CRED_A, "name": "A" }])).await;
    let forwarded: Forwarded = Arc::default();
    let runtime = runtime_for(path, relay.port, Arc::new(Core(forwarded.clone())));
    assert!(runtime.paired_devices().is_empty());
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    eventually("the leg did not open", || runtime.is_connected()).await;

    runtime.list_clients().await.unwrap();
    let mut paired = runtime.paired_devices();
    paired.sort();
    assert_eq!(paired, [CRED_A, CRED_B]);

    let mut phone = relay.pair_phone(&identity, PHONE, CRED_A).await;
    let mut call = |value: Value| phone.send(&value.to_string());

    // Nothing is shown until the phone says so.
    assert!(!runtime.is_client_foreground(CRED_A, "t1"));
    call(json!({ "method": "setScreenSessions", "params": [["t1", "t9", "not an id"]] }));
    eventually("screen not recorded", || runtime.is_client_foreground(CRED_A, "t1")).await;
    assert!(runtime.is_client_foreground(CRED_A, "t9"));
    assert!(!runtime.is_client_foreground(CRED_A, "t2"));
    assert!(!runtime.is_client_foreground(CRED_B, "t1"), "another paired phone shows nothing");

    // Hiding the app removes the claim at once; the browser id it reports names the same leg.
    call(json!({ "method": "setForeground", "params": [false, "browserX"] }));
    eventually("hidden not recorded", || !runtime.is_client_foreground(CRED_A, "t1")).await;
    assert!(!runtime.is_client_foreground("browserX", "t1"));
    call(json!({ "method": "setForeground", "params": [true] }));
    eventually("visible not recorded", || runtime.is_client_foreground("browserX", "t1")).await;
    assert!(runtime.is_client_foreground(CRED_A, "t1"));

    // Everything else is the core's, byte for byte, and the reports before it were not.
    let ordinary = json!({ "id": 2, "method": "listThreads", "params": [] });
    call(ordinary.clone());
    eventually("ordinary call not forwarded", || !forwarded.lock().unwrap().is_empty()).await;
    assert_eq!(*forwarded.lock().unwrap(), [Frame::Text(ordinary.to_string())]);

    // The phone leaves.
    phone.leave();
    eventually("close not applied", || !runtime.is_client_foreground(CRED_A, "t1")).await;
}
