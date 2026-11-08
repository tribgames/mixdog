//! `RemoteRuntime::deliver_push` against a scripted relay (a local WebSocket peer that speaks the
//! leg's frames; no real relay or account), and the PC-signed Web Push store's register/remove.

use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::{SinkExt, StreamExt};
use hkdf::Hkdf;
use mixdog_remote::access::runtime::{PushDelivery, RemoteRuntime};
use mixdog_remote::e2ee::{SealedBox, ServerIdentity, WebPushKeys, generate_claim_key_pair, seal_web_push_keys};
use mixdog_remote::identity::load_or_create_e2ee_identity;
use mixdog_remote::push::legacy::LegacyPushStore;
use mixdog_remote::push::native_crypto::{NATIVE_PUSH_INFO, Reason, collapse_key};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::common;
use common::{NoDial, on_lane, runtime_for};

const AUTH: &str = "MzMzMzMzMzMzMzMzMzMzMw";

/// Accepts one leg, declares the capabilities and the subscriptions, and reports every frame.
async fn scripted_relay(subscriptions: Value) -> (u16, mpsc::UnboundedReceiver<Value>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let caps = json!({
            "type": "relay-capabilities", "binaryFrames": 1, "textFrames": 1, "maxFrameBytes": 1_048_576,
            "nativePush": 1, "nativePushPlatforms": ["apns"], "webPush": 1,
        });
        ws.send(Message::Text(caps.to_string().into())).await.unwrap();
        ws.send(Message::Text(subscriptions.to_string().into())).await.unwrap();
        while let Some(Ok(message)) = ws.next().await {
            if let Message::Text(text) = message
                && let Ok(frame) = serde_json::from_str::<Value>(text.as_str())
            {
                let _ = tx.send(frame);
            }
        }
    });
    (port, rx)
}

async fn frame_of(rx: &mut mpsc::UnboundedReceiver<Value>, kind: &str) -> Value {
    loop {
        let frame = rx.recv().await.expect("relay closed");
        if frame["type"] == kind {
            return frame;
        }
    }
}

struct Rig {
    runtime: RemoteRuntime,
    frames: mpsc::UnboundedReceiver<Value>,
    _dir: tempfile::TempDir,
}

/// A runtime on a leg to the scripted relay; `browsers` are (endpoint, clientId) subscriptions the
/// relay lists, sealed to this PC's pairing material.
async fn rig(browsers: &[(&str, &str)]) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity: ServerIdentity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let keys = WebPushKeys { p256dh: generate_claim_key_pair().public_key, auth: AUTH.to_owned() };
    let rows: Vec<Value> = browsers
        .iter()
        .map(|(endpoint, client)| {
            let sealed: SealedBox = seal_web_push_keys(&identity.pairing(), endpoint, &keys).unwrap();
            json!({ "endpoint": endpoint, "clientId": client, "sealed": sealed })
        })
        .collect();
    let (port, frames) = scripted_relay(json!({ "type": "webpush-subscriptions", "subscriptions": rows })).await;
    let runtime = runtime_for(path, port, Arc::new(NoDial));
    runtime.start(true).await.unwrap();
    let mut rig = Rig { runtime, frames, _dir: dir };
    // The reply to the first subscriptions frame: the capabilities and the set were taken in.
    frame_of(&mut rig.frames, "webpush-ready").await;
    rig
}

fn delivery(device: &str, reason: Reason, body: &str) -> PushDelivery {
    PushDelivery {
        device_id: device.into(),
        session_id: "session-1".into(),
        title: "Title".into(),
        body: body.into(),
        reason,
        host_id: "HOST".into(),
        approval: None,
    }
}

fn decrypt_native(mx: &str, device: &p256::SecretKey) -> Value {
    let envelope: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(mx).unwrap()).unwrap();
    let field = |name: &str| URL_SAFE_NO_PAD.decode(envelope[name].as_str().unwrap()).unwrap();
    assert_eq!(envelope["v"], 1);
    let epk = p256::PublicKey::from_sec1_bytes(&field("epk")).unwrap();
    let shared = p256::ecdh::diffie_hellman(device.to_nonzero_scalar(), epk.as_affine());
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.raw_secret_bytes()).expand(NATIVE_PUSH_INFO, &mut key).unwrap();
    let plain = Aes256Gcm::new((&key).into()).decrypt(Nonce::from_slice(&field("iv")), field("ct").as_slice()).unwrap();
    serde_json::from_slice(&plain).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_with_a_relay_association_is_sent_to_through_the_relay() {
    let mut rig = rig(&[("https://push.example/relay-a", "browserA")]).await;
    rig.runtime.deliver_push(&delivery("browserA", Reason::TurnFinished, "Done.")).await.unwrap();
    let sent = frame_of(&mut rig.frames, "webpush-send").await;
    assert_eq!(sent["endpoint"], "https://push.example/relay-a");
    assert_eq!(sent["clientId"], "browserA");
    assert_eq!(sent["urgency"], "high");
    // RFC 8188: salt(16) + record size(4) + key id length(1) + key id + ciphertext.
    let body = URL_SAFE_NO_PAD.decode(sent["payload"].as_str().unwrap()).unwrap();
    assert!(body.len() > 16 + 4 + 1 + 65);
    assert_eq!(body[20], 65);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_legacy_only_browser_is_tried_directly_and_a_stranger_is_not_an_error() {
    let rig = rig(&[("https://push.example/relay-a", "browserA")]).await;
    let p256dh = generate_claim_key_pair().public_key;
    rig.runtime
        .register_push_subscription(&json!({
            "endpoint": "https://push.invalid/legacy", "p256dh": p256dh, "auth": AUTH, "clientId": "browserB"
        }))
        .await
        .unwrap();
    // `.invalid` never resolves, so the direct send fails and its sentence is what the user reads.
    let refused = rig.runtime.deliver_push(&delivery("browserB", Reason::TurnFinished, "Done.")).await;
    assert!(refused.unwrap_err().starts_with("The push service refused it ("));
    // A device with no subscription anywhere: nothing to say.
    rig.runtime.deliver_push(&delivery("nobody", Reason::TurnFinished, "Done.")).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_native_push_is_bound_encrypted_for_the_phone_and_unbound() {
    let mut rig = rig(&[]).await;
    let phone = generate_claim_key_pair();
    let token = "ab".repeat(32);
    assert!(
        rig.runtime
            .register_native_push("phone1", &json!({ "platform": "apns", "token": token, "publicKey": phone.public_key }))
            .await
            .unwrap()
    );
    let bound = frame_of(&mut rig.frames, "native-push-bind").await;
    assert_eq!((bound["clientId"].as_str(), bound["token"].as_str()), (Some("phone1"), Some(token.as_str())));

    // A failed turn with no words of its own says so; the relay is told "finished".
    rig.runtime.deliver_push(&delivery("phone1", Reason::TurnFailed, "")).await.unwrap();
    let sent = frame_of(&mut rig.frames, "native-push").await;
    assert_eq!(sent["platform"], "apns");
    assert_eq!(sent["token"], token.as_str());
    assert_eq!(sent["sandbox"], false);
    assert_eq!(sent["reason"], "turn-finished");
    assert_eq!(sent["collapseKey"], collapse_key("session-1", Reason::TurnFailed).as_str());
    assert_eq!(
        decrypt_native(sent["mx"].as_str().unwrap(), &phone.secret),
        json!({
            "title": "Title", "body": "The turn stopped with an error.", "sessionId": "session-1",
            "reason": "turn-failed", "hostId": "HOST",
        })
    );

    // An approval travels inside the encryption; the relay is told only the reason. `allowOnce`
    // is written only when true.
    for (allow, expected) in [
        (true, json!({ "approvalId": "ap-1", "allowOnce": true })),
        (false, json!({ "approvalId": "ap-1" })),
    ] {
        let mut push = delivery("phone1", Reason::ApprovalPending, "Needs you.");
        push.approval = Some(("ap-1".into(), allow));
        rig.runtime.deliver_push(&push).await.unwrap();
        let sent = frame_of(&mut rig.frames, "native-push").await;
        assert_eq!(sent["reason"], "approval-pending");
        let content = decrypt_native(sent["mx"].as_str().unwrap(), &phone.secret);
        let mut base = json!({
            "title": "Title", "body": "Needs you.", "sessionId": "session-1",
            "reason": "approval-pending", "hostId": "HOST",
        });
        base.as_object_mut().unwrap().extend(expected.as_object().unwrap().clone());
        assert_eq!(content, base);
    }

    assert!(rig.runtime.remove_native_push("phone1", None).await.unwrap());
    let unbound = frame_of(&mut rig.frames, "native-push-unbind").await;
    assert_eq!(unbound["token"], token.as_str());
}

/// A lane that refuses the job is an error for that call and leaves the native store in place:
/// the next call on a working lane still has its subscriptions (it used to find "unavailable").
#[tokio::test(flavor = "current_thread")]
async fn a_refused_native_push_job_leaves_the_store_usable() {
    let mut rig = rig(&[]).await;
    let phone = generate_claim_key_pair();
    let input = |token: &str| json!({ "platform": "apns", "token": token, "publicKey": phone.public_key });
    {
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        rig.runtime.register_native_push("phone1", &input(&"ab".repeat(32))).await.unwrap_err();
        rig.runtime.remove_native_push("phone1", None).await.unwrap_err();
    }
    let token = "cd".repeat(32);
    assert!(rig.runtime.register_native_push("phone1", &input(&token)).await.unwrap());
    let bound = frame_of(&mut rig.frames, "native-push-bind").await;
    assert_eq!(bound["token"], token.as_str());
}

#[test]
fn the_legacy_store_registers_replaces_and_removes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let p256dh = generate_claim_key_pair().public_key;
    let record = move |endpoint: &str, client: &str| {
        json!({ "endpoint": endpoint, "p256dh": p256dh, "auth": AUTH, "clientId": client, "label": "  My\u{a0}phone  " })
    };
    on_lane(move |lane| {
        let store = LegacyPushStore::new(&path);
        let first = store.register(lane, &record("https://push.example/a", "c1"), 10).unwrap();
        assert_eq!((first.endpoint.as_str(), first.client_id.as_str()), ("https://push.example/a", "c1"));
        store.register(lane, &record("https://push.example/b", "c2"), 11).unwrap();
        // A browser that rotates its endpoint replaces its own row.
        store.register(lane, &record("https://push.example/a2", "c1"), 12).unwrap();
        let endpoints: Vec<_> = store.list(lane).unwrap().into_iter().map(|row| row.endpoint).collect();
        assert_eq!(endpoints, ["https://push.example/b", "https://push.example/a2"]);

        let refused = store.register(lane, &record("http://push.example/x", "c3"), 13).unwrap_err();
        assert_eq!(refused.to_string(), "Push endpoint must use https.");
        assert!(store.register(lane, &json!({ "endpoint": "https://push.example/x" }), 14).is_err());

        assert!(store.remove(lane, "https://push.example/b").unwrap());
        assert!(!store.remove(lane, "https://push.example/b").unwrap());
        assert!(store.remove_by_client(lane, "c1").unwrap());
        assert!(!store.remove_by_client(lane, "c1").unwrap());
        assert!(store.list(lane).unwrap().is_empty());
        // The VAPID identity outlives the subscriptions it served.
        assert_eq!(store.public_key(lane).unwrap(), store.public_key(lane).unwrap());
    });
}
