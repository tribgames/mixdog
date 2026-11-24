//! The native push bindings of a desktop leg and the offline grace: expiry drops what the ended leg bound, never what a later leg bound.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::legs::desktop::DesktopHandle;
use mixdog_relay::legs::hub::{Hub, HubConfig, LegSocket};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::native_push::{BoxFuture, NativePushService, PushMessage, PushSender, SendResult, frames};
use mixdog_relay::store::{DeviceStore, ProfileInput};
use mixdog_relay::ws::FlushCallback;
use serde_json::{Value, json};

const DEVICE: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const SECRET: &str = "0123456789abcdef";
const TOKEN: &str = "abababababababababababababababababababababababababababababababab";

struct Socket;

impl LegSocket for Socket {
    fn is_open(&self) -> bool {
        true
    }
    fn buffered_amount(&self) -> usize {
        0
    }
    fn send_text(&self, _text: Bytes, on_flushed: Option<FlushCallback>) {
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }
    fn send_binary(&self, _data: Bytes, on_flushed: Option<FlushCallback>) {
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }
    fn ping(&self) {}
    fn close(&self, _code: u16, _reason: &[u8]) {}
    fn terminate(&self) {}
    fn hold_uplink(&self, _hold: bool) {}
    fn read_held(&self) -> bool {
        false
    }
}

struct Apns;

impl PushSender for Apns {
    fn platforms(&self) -> Vec<&'static str> {
        vec!["apns"]
    }
    fn send<'a>(&'a self, _message: &'a PushMessage) -> BoxFuture<'a, SendResult> {
        Box::pin(async { SendResult { ok: true, status: 200, invalid: false, error: None } })
    }
    fn close(&self) {}
}

struct Rig {
    hub: Arc<Hub>,
    service: Arc<NativePushService>,
    _dir: tempfile::TempDir,
}

async fn rig(before_native: impl FnOnce(&Arc<Hub>, &Arc<NativePushService>)) -> Rig {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = DeviceStore::open(dir.path(), mixdog_rt::testing::tokens().durability_io).await.expect("the store opens");
    assert!(store.authenticate(DEVICE, SECRET).await);
    for client in ["aaaaaaaa", "bbbbbbbb"] {
        assert!(store.register_client(DEVICE, client, &ProfileInput::text("Pixel", "android", "chrome")).await.is_some());
    }
    let hub = Hub::new(store, HubConfig::default(), IngressPool::new());
    let service = Arc::new(NativePushService::new(Some(Arc::new(Apns) as Arc<dyn PushSender>)));
    before_native(&hub, &service);
    frames::register(hub.dispatch(), &service).expect("native push registers");
    Rig { hub, service, _dir: dir }
}

fn attach(hub: &Arc<Hub>) -> DesktopHandle {
    hub.attach_desktop(DEVICE, Arc::new(Socket), None)
}

fn bind_frame(client: &str) -> Value {
    json!({ "type": "native-push-bind", "clientId": client, "platform": "apns", "token": TOKEN })
}

async fn bind(handle: &DesktopHandle, client: &str) {
    handle.frame(Bytes::from(mixdog_relay::js::wire(&bind_frame(client))), false).await;
}

async fn elapse(duration: Duration) {
    let mut left = duration.as_millis() as u64;
    while left > 0 {
        let slice = left.min(5);
        tokio::time::advance(Duration::from_millis(slice)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        left -= slice;
    }
}

#[tokio::test(start_paused = true)]
async fn a_desktop_gone_past_the_grace_loses_the_bindings_its_leg_made() {
    let rig = rig(|_, _| {}).await;
    let leg = attach(&rig.hub);
    bind(&leg, "aaaaaaaa").await;
    assert_eq!(rig.service.association_count(TOKEN), Some(1));
    leg.closed();
    elapse(Duration::from_secs(44)).await;
    assert_eq!(rig.service.association_count(TOKEN), Some(1), "the grace has not passed");
    elapse(Duration::from_secs(2)).await;
    assert_eq!(rig.service.association_count(TOKEN), None);
    assert_eq!(rig.service.device_token_count(DEVICE), 0);
}

#[tokio::test(start_paused = true)]
async fn a_desktop_that_reconnects_within_the_grace_keeps_its_bindings() {
    let rig = rig(|_, _| {}).await;
    let first = attach(&rig.hub);
    bind(&first, "aaaaaaaa").await;
    first.closed();
    elapse(Duration::from_secs(30)).await;
    let second = attach(&rig.hub);
    bind(&second, "bbbbbbbb").await;
    elapse(Duration::from_secs(120)).await;
    assert_eq!(rig.service.association_count(TOKEN), Some(2));
    second.closed();
    elapse(Duration::from_secs(46)).await;
    assert_eq!(rig.service.association_count(TOKEN), None);
}

#[tokio::test(start_paused = true)]
async fn a_reconnect_racing_the_expiry_keeps_what_the_new_leg_bound() {
    let replacement: Arc<Mutex<Option<DesktopHandle>>> = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&replacement);
    let raced = Arc::new(AtomicBool::new(false));
    // Runs between the hub's check that the leg is the live one and the native push hook: the redial and its bind land there.
    let rig = rig(move |hub, service| {
        let (hub, service) = (Arc::clone(hub), Arc::clone(service));
        hub.dispatch().register_offline_hook(Arc::new({
            let hub = Arc::clone(&hub);
            move |device_id: &str, _generation: u64| {
                if raced.swap(true, Ordering::SeqCst) {
                    return;
                }
                let leg = attach(&hub);
                service.bind_for_leg(device_id, leg.generation(), hub.store(), &bind_frame("bbbbbbbb"));
                *slot.lock().unwrap() = Some(leg);
            }
        }));
    })
    .await;
    let first = attach(&rig.hub);
    bind(&first, "aaaaaaaa").await;
    assert_eq!(rig.service.association_count(TOKEN), Some(1));
    first.closed();
    elapse(Duration::from_secs(46)).await;
    let second = replacement.lock().unwrap().take().expect("the redial happened during the expiry");
    assert!(second.generation() > first.generation());
    assert_eq!(rig.service.association_count(TOKEN), Some(1), "only the new leg's binding is left");
    assert_eq!(rig.service.device_token_count(DEVICE), 1);
    second.closed();
    elapse(Duration::from_secs(46)).await;
    assert_eq!(rig.service.association_count(TOKEN), None);
}