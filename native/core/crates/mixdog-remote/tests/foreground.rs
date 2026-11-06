//! A phone's account of its own screen (`ui/screenSessions/changed`, recorded by the core in the
//! registry against the phone's relay connection) decides `is_credential_foreground` and
//! `is_browser_foreground`. The phone is paired over a real E2EE channel through a scripted
//! relay; the notification itself is forwarded to the core untouched. `paired_devices` lists the
//! credentials the relay reported.

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
async fn a_phone_reporting_its_screen_decides_foreground() {
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
    let mut rows: Vec<_> = runtime.paired_clients().into_iter().map(|row| (row.id, row.name)).collect();
    rows.sort();
    assert_eq!(rows, [(CRED_A.to_owned(), "A".to_owned()), (CRED_B.to_owned(), "B".to_owned())]);

    let mut phone = relay.pair_phone(&identity, PHONE, CRED_A).await;
    let mut call = |value: Value| phone.send(&value.to_string());

    // Nothing is shown until the phone says so.
    // The core accepted the phone's bridged connection (as the server's accept path does) and
    // the phone's `ui/screenSessions/changed` reaches the registry through it.
    let registry = runtime.registry();
    registry.connect_relay(7, PHONE);
    eventually("the phone was not attached", || registry.describe(7).is_some()).await;
    assert!(!runtime.is_credential_foreground(CRED_A, "t1"), "nothing is shown until the phone says so");
    assert!(registry.report_screen(7, ["t1", "t9"].map(String::from).into(), Some("browserX")));
    assert!(runtime.is_credential_foreground(CRED_A, "t1") && runtime.is_credential_foreground(CRED_A, "t9"));
    assert!(!runtime.is_credential_foreground(CRED_A, "t2"));
    assert!(!runtime.is_credential_foreground(CRED_B, "t1"), "another paired phone shows nothing");
    assert!(runtime.is_browser_foreground("browserX", "t1"));

    // The two identities are separate questions: a phone paired as A that reports B's
    // credential id as its browser id does not make B foreground, and a credential id is no
    // browser id.
    assert!(registry.report_screen(7, ["t1"].map(String::from).into(), Some(CRED_B)));
    assert!(runtime.is_browser_foreground(CRED_B, "t1"));
    assert!(!runtime.is_credential_foreground(CRED_B, "t1"));
    assert!(!runtime.is_browser_foreground(CRED_A, "t1"));
    // A backgrounded phone sends an empty set.
    assert!(registry.report_screen(7, Default::default(), None));
    assert!(!runtime.is_credential_foreground(CRED_A, "t1") && !runtime.is_browser_foreground(CRED_B, "t1"));
    assert!(registry.report_screen(7, ["t1"].map(String::from).into(), None));

    // Every frame is the core's, byte for byte: the runtime no longer reads the phone's text.
    let screen = json!({ "method": "ui/screenSessions/changed", "params": { "sessionIds": ["t1"] } });
    call(screen.clone());
    eventually("the notification was not forwarded", || !forwarded.lock().unwrap().is_empty()).await;
    assert_eq!(*forwarded.lock().unwrap(), [Frame::Text(screen.to_string())]);

    // The phone leaves.
    phone.leave();
    eventually("close not applied", || !runtime.is_credential_foreground(CRED_A, "t1")).await;
}
