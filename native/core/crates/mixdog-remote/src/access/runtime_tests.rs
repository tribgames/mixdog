//! The runtime against a scripted relay on loopback, which takes every leg the desktop dials at once (its own, and the one-shot
//! legs of the registrations it revokes) and names each by the device it authenticated as.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use futures::{SinkExt, StreamExt};
use mixdog_core_api::state::{SectionChange, StatePublisher};
use mixdog_protocol::SectionName;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

use super::*;
use crate::bridge::{DialError, UpEvent, Upstream};
use crate::e2ee::{Challenge, Channel, ClientHandshakeOptions, E2eeError, PairingMaterial, Wire, create_client_handshake, generate_claim_key_pair};
use crate::section::RemoteSectionValue;

const CRED: &str = "0123456789abcdef0123456789abcdef";

struct Silent;
impl StatePublisher for Silent {
    fn publish(&self, _: SectionName, _: Option<String>, _: SectionChange) {}
}

struct Quiet;
impl RemoteEvents for Quiet {
    fn controller_key_delivered(&self, _: &str) {}
    fn owed_access_changed(&self) {}
    fn status(&self, _: Value) {}
}

struct NoEffects;
impl PairCodeEffects for NoEffects {
    fn send(&mut self, _: Value) -> bool {
        false
    }
    fn publish(&mut self, _: Option<&PairCodeView>) {}
    fn wake_at(&mut self, _: u64) {}
}

/// A core that takes every bridged socket and says nothing on it.
struct IdleCore;
struct Idle;

#[async_trait]
impl Upstream for Idle {
    async fn send(&mut self, _: Frame) -> Result<(), DialError> {
        Ok(())
    }
    async fn recv(&mut self) -> Option<UpEvent> {
        std::future::pending().await
    }
    async fn close(&mut self, _: u16) {}
}

#[async_trait]
impl Dialer for IdleCore {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        Ok(Box::new(Idle))
    }
}

/// A frame the desktop sent, with the device its leg authenticated as.
type Seen = (String, Value);
type Legs = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>>;

/// The device id of a leg's Basic credential.
fn device_of(request: &Request) -> String {
    let credential = request.headers().get("authorization").and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Basic "));
    let decoded = credential.and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok()).unwrap_or_default();
    String::from_utf8_lossy(&decoded).split(':').next().unwrap_or_default().to_owned()
}

/// What the relay answers itself: the listing of `clients`, `revoke_ok` to an unpair, and every device revocation confirmed.
fn answer(frame: &Value, revoke_ok: bool, clients: &Value) -> Option<Value> {
    match frame["type"].as_str()? {
        "list-clients" => Some(json!({ "type": "clients-list", "requestId": frame["requestId"], "clients": clients })),
        "revoke-client" => Some(json!({ "type": "client-revoked", "requestId": frame["requestId"], "ok": revoke_ok })),
        "revoke-device" => Some(json!({ "type": "device-revoked", "ok": true })),
        _ => None,
    }
}

/// One leg: the capabilities, without the `binaryFrames` a relay may withhold, then the relay's answers and the test's frames.
async fn serve(stream: tokio::net::TcpStream, revoke_ok: bool, clients: Value, seen: mpsc::UnboundedSender<Seen>, legs: Legs, stalls: Arc<AtomicUsize>) {
    let named = Arc::new(Mutex::new(String::new()));
    let name = named.clone();
    let callback = move |request: &Request, response: Response| {
        *lock(&name) = device_of(request);
        Ok::<_, ErrorResponse>(response)
    };
    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
    let device = lock(&named).clone();
    let (to_leg, mut outbox) = mpsc::unbounded_channel::<Value>();
    lock(&legs).insert(device.clone(), to_leg);
    let caps = json!({ "type": "relay-capabilities", "textFrames": 1, "maxFrameBytes": 1_048_576 });
    if ws.send(Message::Text(caps.to_string().into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            // `biased`: what the test queued goes out before the answer to a request read in the same wake.
            biased;
            frame = outbox.recv() => {
                let Some(frame) = frame else { return };
                if ws.send(Message::Text(frame.to_string().into())).await.is_err() {
                    return;
                }
            }
            message = ws.next() => {
                let Some(Ok(message)) = message else { return };
                let Message::Text(text) = message else { continue };
                let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                let stalled = frame["type"] == "revoke-device" && stalls.try_update(Ordering::SeqCst, Ordering::SeqCst, |left| left.checked_sub(1)).is_ok();
                if !stalled
                    && let Some(reply) = answer(&frame, revoke_ok, &clients)
                    && ws.send(Message::Text(reply.to_string().into())).await.is_err()
                {
                    return;
                }
                let _ = seen.send((device.clone(), frame));
            }
        }
    }
}

struct Relay {
    port: u16,
    seen: mpsc::UnboundedReceiver<Seen>,
    backlog: Vec<Seen>,
    /// The writer of each device's latest leg.
    legs: Legs,
    /// Device revocations still to read and leave unanswered, their legs held open and silent.
    stalls: Arc<AtomicUsize>,
}

impl Relay {
    async fn start(revoke_ok: bool) -> Self {
        Self::listing(revoke_ok, &[]).await
    }

    /// A relay that lists the paired devices `clients`.
    async fn listing(revoke_ok: bool, clients: &[&str]) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, seen) = mpsc::unbounded_channel();
        let legs = Legs::default();
        let held = legs.clone();
        let stalls = Arc::new(AtomicUsize::new(0));
        let left = stalls.clone();
        let clients: Value = clients.iter().map(|id| json!({ "id": id })).collect();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, revoke_ok, clients.clone(), seen_tx.clone(), held.clone(), left.clone()));
            }
        });
        Self { port, seen, backlog: Vec::new(), legs, stalls }
    }

    /// The next `count` device revocations are read and never answered: each exchange stalls past its upgrade.
    fn stall_revocations(&self, count: usize) {
        self.stalls.store(count, Ordering::SeqCst);
    }

    /// Ends the latest leg of `device` with no close frame, as a lost network path does.
    fn lose(&self, device: &str) {
        lock(&self.legs).remove(device);
    }

    /// The first frame, kept or still to come, that `wanted` accepts; the others stay for later asks.
    async fn frame(&mut self, wanted: impl Fn(&str, &Value) -> bool) -> Seen {
        if let Some(at) = self.backlog.iter().position(|(device, frame)| wanted(device, frame)) {
            return self.backlog.remove(at);
        }
        loop {
            let seen = self.seen.recv().await.expect("the relay ended");
            if wanted(&seen.0, &seen.1) {
                return seen;
            }
            self.backlog.push(seen);
        }
    }

    /// Every frame that arrived so far and `wanted` accepts, without waiting for more.
    fn arrived(&mut self, wanted: impl Fn(&str, &Value) -> bool) -> Vec<Value> {
        while let Ok(seen) = self.seen.try_recv() {
            self.backlog.push(seen);
        }
        self.backlog.iter().filter(|(device, frame)| wanted(device, frame)).map(|(_, frame)| frame.clone()).collect()
    }

    /// The device of the desktop's leg, once it announced its pairing token (the last of what a leg sends on open).
    async fn leg(&mut self) -> String {
        self.frame(|_, frame| frame["type"] == "set-client-token").await.0
    }

    /// Writes `frame` to the latest leg of `device`.
    fn send(&self, device: &str, frame: Value) {
        lock(&self.legs)[device].send(frame).unwrap();
    }

    /// What the desktop sent client `id` next: a frame's data, or the reason it closed the client.
    async fn to_client(&mut self, id: &str) -> Result<String, String> {
        let (_, frame) = self.frame(|_, frame| matches!(frame["type"].as_str(), Some("frame" | "close-client")) && frame["clientId"] == id).await;
        let text = |name: &str| frame[name].as_str().unwrap_or_default().to_owned();
        if frame["type"] == "close-client" { Err(text("reason")) } else { Ok(text("data")) }
    }

    /// The phone `id` of `credential` opens and completes its handshake.
    async fn pair(&mut self, device: &str, pairing: &PairingMaterial, id: &str, credential: &str) -> Channel {
        self.send(device, json!({ "type": "client-open", "clientId": id, "browserClientId": credential }));
        let challenge = Challenge::parse(serde_json::from_str(&self.to_client(id).await.unwrap()).unwrap()).unwrap();
        let (hello, mut channel) = create_client_handshake(pairing, &challenge, ClientHandshakeOptions::default()).unwrap();
        self.send(device, json!({ "type": "frame", "clientId": id, "data": hello.to_string() }));
        let ready: Value = serde_json::from_slice(&channel.open(Wire::Text(&self.to_client(id).await.unwrap())).unwrap()).unwrap();
        assert_eq!(ready["type"], "e2ee-ready");
        channel
    }
}

/// A runtime over the remote-access files in `dir`, switched on against the relay at `port`.
async fn runtime(dir: &std::path::Path, port: u16) -> RemoteRuntime {
    let cfg = RuntimeConfig {
        dir: dir.to_path_buf(),
        relay_url: Some(format!("ws://127.0.0.1:{port}")),
        app_version: None,
        durability: mixdog_rt::testing::tokens().durability_io,
        dialer: Arc::new(IdleCore),
        registry: Arc::new(DeviceRegistry::default()),
        section: Arc::new(RemoteSection::new(Arc::new(Silent), RemoteSectionValue::default())),
        settings: Arc::new(AccessSettings::new(dir.to_path_buf(), Arc::new(|| "PC".to_owned()))),
        link: LegLink::default(),
        events: Arc::new(Quiet),
    };
    let runtime = RemoteRuntime::new(cfg, Box::new(|_| Box::new(NoEffects)));
    runtime.prepare().await.unwrap();
    runtime.start(true).await.unwrap();
    runtime
}

/// A rotation's replaced registration is deleted at the relay on a leg authenticated as itself, and leaves the queue once the
/// relay confirmed it; the live registration is not asked to delete itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_rotation_revokes_the_replaced_registration_at_the_relay() {
    let dir = tempfile::tempdir().unwrap();
    let mut relay = Relay::start(true).await;
    let runtime = runtime(dir.path(), relay.port).await;
    let replaced = relay.leg().await;
    runtime.rotate().await.unwrap();
    // Nothing but the drain sends `revoke-device`: the bound makes a revocation that never comes a failure, not a hang.
    let revoked = mixdog_rt::time::timeout(Duration::from_secs(30), relay.frame(|_, frame| frame["type"] == "revoke-device")).await;
    let (device, _) = revoked.expect("the replaced registration was never revoked");
    assert_eq!(device, replaced);
    assert_ne!(runtime.host_id(), replaced, "the live registration is another");
    // The drain holds its permit until the confirmed identity has left the queue.
    drop(runtime.inner.device_drain.acquire().await.unwrap());
    let path = dir.path().to_path_buf();
    let queued = runtime.inner.durable(move |lane| DeviceFiles::new(path).load_queue(lane)).await.unwrap().unwrap();
    assert!(queued.is_empty(), "the confirmed revocation left the queue");
    runtime.close().await;
}

/// A revocation the relay leaves unanswered after the upgrade holds the drain no longer than the connection it started on: once
/// that leg is lost and opened again, the replaced registration is revoked on the new connection and leaves the queue.
#[tokio::test(flavor = "multi_thread")]
async fn a_revocation_stalled_on_a_lost_connection_is_made_on_the_next() {
    let bound = Duration::from_secs(30);
    let revocation = |_: &str, frame: &Value| frame["type"] == "revoke-device";
    let dir = tempfile::tempdir().unwrap();
    let mut relay = Relay::start(true).await;
    relay.stall_revocations(1);
    let runtime = runtime(dir.path(), relay.port).await;
    let replaced = relay.leg().await;
    runtime.rotate().await.unwrap();
    let live = relay.leg().await;
    let (device, _) = mixdog_rt::time::timeout(bound, relay.frame(revocation)).await.expect("the replaced registration was never asked");
    assert_eq!(device, replaced, "the stalled exchange is the replaced registration's");
    relay.lose(&live);
    let reopened = mixdog_rt::time::timeout(bound, relay.leg()).await.expect("the leg was never opened again");
    assert_eq!(reopened, live);
    let (device, _) = mixdog_rt::time::timeout(bound, relay.frame(revocation)).await.expect("the pending revocation waited on the lost connection");
    assert_eq!(device, replaced);
    // The relay confirmed this one; the drain holds its permit until the identity has left the queue.
    drop(runtime.inner.device_drain.acquire().await.unwrap());
    let path = dir.path().to_path_buf();
    let queued = runtime.inner.durable(move |lane| DeviceFiles::new(path).load_queue(lane)).await.unwrap().unwrap();
    assert!(queued.is_empty(), "the revocation acknowledged on the new connection left the queue");
    runtime.close().await;
}

/// An unpair the relay refuses still ends the device's access: its live client is closed before the relay is asked, with the
/// reason phones read as a lost pairing, and its next connection is refused at the open.
#[tokio::test(flavor = "multi_thread")]
async fn an_unpaired_device_is_closed_now_and_refused_at_a_later_open_whatever_the_relay_did() {
    let dir = tempfile::tempdir().unwrap();
    let mut relay = Relay::start(false).await;
    let runtime = runtime(dir.path(), relay.port).await;
    let device = relay.leg().await;
    let pairing = runtime.inner.live().unwrap().identity.pairing();
    let _phone = relay.pair(&device, &pairing, "p1", CRED).await;

    assert!(runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    relay.frame(|_, frame| frame["type"] == "revoke-client").await;
    let closed = relay.arrived(|_, frame| frame["type"] == "close-client" && frame["clientId"] == "p1");
    assert_eq!(closed, vec![json!({ "type": "close-client", "clientId": "p1", "reason": UNPAIRED_CLOSE })]);

    relay.send(&device, json!({ "type": "client-open", "clientId": "p2", "browserClientId": CRED }));
    assert_eq!(relay.to_client("p2").await, Err(UNPAIRED_CLOSE.to_owned()), "refused, not challenged");
    runtime.close().await;
}

/// A relay that withholds `binaryFrames` and strips the transport offer and `deflate` from the challenge in transit is caught: the
/// phone's transcript check sees the challenge it was given is not the one offered.
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_that_withholds_binary_frames_cannot_alter_the_handshake_unseen() {
    let dir = tempfile::tempdir().unwrap();
    let mut relay = Relay::start(true).await;
    let runtime = runtime(dir.path(), relay.port).await;
    let device = relay.leg().await;
    let pairing = runtime.inner.live().unwrap().identity.pairing();
    relay.send(&device, json!({ "type": "client-open", "clientId": "p1", "browserClientId": CRED }));
    let mut offered: Value = serde_json::from_str(&relay.to_client("p1").await.unwrap()).unwrap();
    let members = offered.as_object_mut().unwrap();
    members.shift_remove("transportWebrtc");
    members.shift_remove("deflate");
    let challenge = Challenge::parse(offered).unwrap();
    let (hello, mut phone) = create_client_handshake(&pairing, &challenge, ClientHandshakeOptions { transport: true, ..Default::default() }).unwrap();
    relay.send(&device, json!({ "type": "frame", "clientId": "p1", "data": hello.to_string() }));
    let ready: Value = serde_json::from_slice(&phone.open(Wire::Text(&relay.to_client("p1").await.unwrap())).unwrap()).unwrap();
    assert_eq!(phone.confirm_handshake(&ready), Err(E2eeError::TranscriptMismatch));
    runtime.close().await;
}

/// A device's push subscription is filed under its own credential whatever `clientId` it names; another credential naming its
/// endpoint with other keys is refused, and neither a registration nor a removal touches another device's row.
#[tokio::test(flavor = "multi_thread")]
async fn a_push_subscription_belongs_to_the_credential_that_registered_it() {
    let dir = tempfile::tempdir().unwrap();
    let relay = Relay::start(true).await;
    let runtime = runtime(dir.path(), relay.port).await;
    let keys = generate_claim_key_pair().public_key;
    let subscription =
        |p256dh: &str| json!({ "endpoint": "https://push.example/b", "p256dh": p256dh, "auth": "AAAAAAAAAAAAAAAAAAAAAA", "clientId": "device-b" });
    runtime.register_push_subscription("device-b", &subscription(&keys)).await.unwrap();
    assert!(!runtime.remove_push_subscription("device-a", &json!("https://push.example/b")).await.unwrap(), "B's row is not A's to remove");
    // Device A names B, and B's endpoint, with keys of its own: B's browser would no longer read what is sent to it.
    let refused = runtime.register_push_subscription("device-a", &subscription(&generate_claim_key_pair().public_key)).await.unwrap_err();
    assert!(matches!(&refused, RemoteError::Invalid(message) if message == "This push endpoint is registered with other keys."), "{refused:?}");
    // With B's own keys it is B's browser, paired again.
    runtime.register_push_subscription("device-a", &subscription(&keys)).await.unwrap();
    let path = dir.path().to_path_buf();
    let rows = runtime.inner.durable(move |lane| crate::push::legacy::LegacyPushStore::new(&path).list(lane)).await.unwrap().unwrap();
    let owners: Vec<_> = rows.iter().map(|row| (row.client_id.as_str(), row.endpoint.as_str())).collect();
    assert_eq!(owners, [("device-b", "https://push.example/b"), ("device-a", "https://push.example/b")]);
    assert!(runtime.remove_push_subscription("device-a", &json!("https://push.example/b")).await.unwrap());
    let path = dir.path().to_path_buf();
    let rows = runtime.inner.durable(move |lane| crate::push::legacy::LegacyPushStore::new(&path).list(lane)).await.unwrap().unwrap();
    assert_eq!(rows.iter().map(|row| row.client_id.as_str()).collect::<Vec<_>>(), ["device-b"], "only A's own row went");
    runtime.close().await;
}

/// Whether a notification for `device` was posted to its browser at `push.invalid`, a name that never resolves: a post is one the
/// push service refused, and a delivery that posts nothing finds the device without notifications.
async fn posted(runtime: &RemoteRuntime, device: &str) -> bool {
    let push = PushDelivery {
        device_id: device.into(),
        session_id: "session-1".into(),
        title: "Title".into(),
        body: "Done.".into(),
        reason: Reason::TurnFinished,
        host_id: String::new(),
        approval: None,
    };
    match runtime.deliver_push(&push).await {
        Err(sentence) if sentence.starts_with("The push service refused it (") => true,
        Err(sentence) if sentence == PUSH_NOT_ALLOWED => false,
        other => panic!("{other:?}"),
    }
}

/// A browser paired again while its old pairing is still listed holds its one endpoint under both: a notification both devices
/// hear is posted to it once, through the newer pairing, and after an unpair of either it is still posted to through the other.
#[tokio::test(flavor = "multi_thread")]
async fn a_browser_paired_twice_is_posted_to_once_and_stays_subscribed_through_either_unpair() {
    const OLD: &str = "1111111111111111aaaaaaaaaaaaaaaa";
    const NEW: &str = "2222222222222222bbbbbbbbbbbbbbbb";
    let browser = json!({ "endpoint": "https://push.invalid/browser", "p256dh": generate_claim_key_pair().public_key, "auth": "AAAAAAAAAAAAAAAAAAAAAA" });
    for (unpaired, kept) in [(OLD, NEW), (NEW, OLD)] {
        let dir = tempfile::tempdir().unwrap();
        // The relay refuses the unpair, so the unpaired device's row stays and only its pairing ends.
        let mut relay = Relay::listing(false, &[OLD, NEW]).await;
        let runtime = runtime(dir.path(), relay.port).await;
        relay.leg().await;
        runtime.list_clients().await.unwrap();
        for credential in [OLD, NEW] {
            runtime.register_push_subscription(credential, &browser).await.unwrap();
        }
        assert_eq!((posted(&runtime, OLD).await, posted(&runtime, NEW).await), (false, true), "one post, through the newer pairing");
        assert!(runtime.revoke_client(unpaired).await.is_err(), "the relay refused the unpair");
        assert!(posted(&runtime, kept).await, "posted through {kept} once {unpaired} was unpaired");
        runtime.close().await;
    }
}

/// A pairing prompt ends with the leg it came on: once remote access is switched off it is gone from the state and cannot be
/// approved, since no leg could carry the answer.
#[tokio::test(flavor = "multi_thread")]
async fn a_pairing_prompt_ends_with_its_leg() {
    let dir = tempfile::tempdir().unwrap();
    let mut relay = Relay::start(true).await;
    let runtime = runtime(dir.path(), relay.port).await;
    let device = relay.leg().await;
    let claim = json!({
        "type": "client-claim", "claimId": "claim-1", "clientId": "browser-1",
        "publicKey": generate_claim_key_pair().public_key, "expiresAt": now_ms() + 60_000,
    });
    relay.send(&device, claim);
    // The relay wrote the claim before its answer to this listing, and the leg is read in order.
    runtime.list_clients().await.unwrap();
    assert_eq!(runtime.section_value().claims.len(), 1, "the prompt is shown");
    runtime.stop().await.unwrap();
    assert!(runtime.section_value().claims.is_empty(), "the prompt went with its leg");
    assert!(!runtime.resolve_claim("claim-1", true).await.unwrap(), "no prompt is left to approve");
    runtime.close().await;
}
