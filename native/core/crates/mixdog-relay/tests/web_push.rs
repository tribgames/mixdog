//! Relay-owned Web Push: identity, endpoint policy, sender, registry persistence and quotas, send validation, the `webpush-send` flow and the files the relay writes. The HTTP client is a trait seam; no process or real push service is started.

use std::path::Path;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_relay::web_push::WebPush;
use mixdog_relay::web_push::endpoint::valid_endpoint;
use mixdog_relay::web_push::registry::{Bind, Capable, Registry, SUBSCRIPTIONS_FILE, Sealed, Unbind};
use mixdog_relay::web_push::send::{Options, PushClient, PushFuture, PushRequest, SendRequest, Sender, web_push_body, web_push_options};
use mixdog_relay::web_push::vapid::{VAPID_FILE, VAPID_SUBJECT, VapidKeys, vapid_authorization};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{Value, json};

const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/subscription-1";

fn read(path: &Path) -> String {
    String::from_utf8(mixdog_fsio::read(&mixdog_fsio::Unlaned, path).unwrap()).unwrap()
}

fn write(path: &Path, text: &str) {
    mixdog_fsio::write(&mixdog_fsio::Unlaned, path, text).unwrap();
}

fn sealed_value(tag: &str) -> Value {
    json!({
        "version": 1,
        "ephemeralPublicKey": format!("B{}", tag.repeat(86)),
        "nonce": "n".repeat(16),
        "ciphertext": tag.repeat(40),
    })
}

fn sealed(tag: &str) -> Sealed {
    Sealed::from_value(&sealed_value(tag)).unwrap()
}

/// Every later write of the registry fails: its path becomes a directory. Returns what undoes it.
fn block_registry_writes(dir: &Path) -> impl FnOnce() + use<> {
    let path = dir.join(SUBSCRIPTIONS_FILE);
    mixdog_fsio::remove_file(&mixdog_fsio::Unlaned, &path).ok();
    mixdog_fsio::create_dir(&mixdog_fsio::Unlaned, &path).unwrap();
    move || mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, &path).unwrap()
}

/// A push service that records what it is sent and answers with one status.
struct PushService {
    requests: Mutex<Vec<PushRequest>>,
    status: AtomicU16,
}

impl PushService {
    fn new() -> Arc<Self> {
        Arc::new(Self { requests: Mutex::new(Vec::new()), status: AtomicU16::new(201) })
    }

    fn respond(&self, status: u16) {
        self.status.store(status, Ordering::SeqCst);
    }

    fn posted(&self) -> Vec<PushRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl PushClient for PushService {
    fn post(&self, request: PushRequest) -> PushFuture<'_> {
        self.requests.lock().unwrap().push(request);
        let status = self.status.load(Ordering::SeqCst);
        Box::pin(async move { Ok(status) })
    }
}

/// The key a push service reads from `k=`: the uncompressed point back to a verifying key.
fn verifying_key(raw: &str) -> VerifyingKey {
    VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(raw).unwrap()).unwrap()
}

/// Verifies an `Authorization: vapid t=..., k=...` header the way a push service does; returns the `k=` key.
fn verify_vapid(header: &str, endpoint: &str) -> String {
    let rest = header.strip_prefix("vapid t=").expect(header);
    let (token, key) = rest.split_once(", k=").expect(header);
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3, "{header}");
    let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).unwrap();
    let header_json: Value = serde_json::from_slice(&decode(parts[0])).unwrap();
    assert_eq!(header_json, json!({ "typ": "JWT", "alg": "ES256" }));
    let claims: Value = serde_json::from_slice(&decode(parts[1])).unwrap();
    let origin = endpoint.split('/').take(3).collect::<Vec<_>>().join("/");
    assert_eq!(claims["aud"], json!(origin));
    let now = mixdog_relay::rate_limit::now_ms() / 1000;
    let exp = claims["exp"].as_i64().unwrap();
    assert!(exp > now && exp <= now + 24 * 3600);
    assert!(claims["sub"].as_str().unwrap().starts_with("mailto:"));
    let signature = Signature::from_slice(&decode(parts[2])).unwrap();
    verifying_key(key).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).unwrap();
    key.to_owned()
}

fn header<'a>(request: &'a PushRequest, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(held, _)| *held == name).map(|(_, value)| value.as_str())
}

// ---- identity ----

#[test]
fn the_relay_mints_its_vapid_identity_once_keeps_it_and_signs_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let first = VapidKeys::load_or_create(dir.path()).unwrap();
    let public = first.public_key().to_owned();
    assert_eq!(public.len(), 87);
    assert_eq!(URL_SAFE_NO_PAD.decode(&public).unwrap()[0], 0x04);
    let text = read(&dir.path().join(VAPID_FILE));
    let stored: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(stored["publicKey"], json!(public));
    // The file layout: version, publicKey, privateKeyJwk{kty,x,y,crv,d}.
    let keys: Vec<&String> = stored.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["version", "publicKey", "privateKeyJwk"]);
    let jwk_keys: Vec<&String> = stored["privateKeyJwk"].as_object().unwrap().keys().collect();
    assert_eq!(jwk_keys, ["kty", "x", "y", "crv", "d"]);
    assert_eq!(stored["privateKeyJwk"]["crv"], json!("P-256"));
    // A restart reads the same identity: rotating it would strand every subscription.
    let second = VapidKeys::load_or_create(dir.path()).unwrap();
    assert_eq!(second.public_key(), public);
    assert_eq!(read(&dir.path().join(VAPID_FILE)), text);
    let authorization = vapid_authorization(ENDPOINT, &second, VAPID_SUBJECT, mixdog_relay::rate_limit::now_ms()).unwrap();
    assert_eq!(verify_vapid(&authorization, ENDPOINT), public);
}

#[test]
fn an_unreadable_identity_disables_web_push_instead_of_being_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(VAPID_FILE);
    write(&path, r#"{"publicKey":"x","privateKeyJwk":{}}"#);
    assert!(VapidKeys::load_or_create(dir.path()).is_none());
    assert_eq!(read(&path), r#"{"publicKey":"x","privateKeyJwk":{}}"#);
    write(&path, "not json");
    assert!(VapidKeys::load_or_create(dir.path()).is_none());
    assert_eq!(read(&path), "not json");
}

#[test]
fn a_public_key_that_is_not_the_private_keys_disables_web_push() {
    let source = tempfile::tempdir().unwrap();
    VapidKeys::load_or_create(source.path()).unwrap();
    let other = tempfile::tempdir().unwrap();
    VapidKeys::load_or_create(other.path()).unwrap();
    let mut stored: Value = serde_json::from_str(&read(&source.path().join(VAPID_FILE))).unwrap();
    let foreign: Value = serde_json::from_str(&read(&other.path().join(VAPID_FILE))).unwrap();
    stored["publicKey"] = foreign["publicKey"].clone();
    let dir = tempfile::tempdir().unwrap();
    write(&dir.path().join(VAPID_FILE), &stored.to_string());
    assert!(VapidKeys::load_or_create(dir.path()).is_none());
}

#[test]
fn an_identity_that_cannot_be_stored_disables_web_push() {
    let dir = tempfile::tempdir().unwrap();
    // The data directory is a file: nothing can be created in it.
    let blocked = dir.path().join("data");
    write(&blocked, "a file");
    assert!(VapidKeys::load_or_create(&blocked).is_none());
}

// ---- endpoint policy ----

#[test]
fn only_endpoints_on_a_known_push_service_are_accepted_in_one_canonical_spelling() {
    for good in [
        "https://fcm.googleapis.com/fcm/send/a",
        "https://fcm.googleapis.com/wp/a",
        "https://updates.push.services.mozilla.com/wpush/v2/a",
        "https://web.push.apple.com/a",
        "https://wns2-par02p.notify.windows.com/w/?token=a",
    ] {
        assert_eq!(valid_endpoint(good).as_deref(), Some(good), "{good}");
    }
    // Case and trailing root dots name the same host: matched and stored canonical.
    assert_eq!(valid_endpoint("https://FCM.googleapis.com./fcm/send/a").as_deref(), Some("https://fcm.googleapis.com/fcm/send/a"));
    for bad in [
        "",
        "http://fcm.googleapis.com/a",
        "https://127.0.0.1/a",
        "https://[::1]/a",
        "https://localhost/a",
        "https://localhost./x",
        "https://service.internal./x",
        "https://intranet/a",
        // Public names resolve wherever their owner points them.
        "https://push.example.com/a",
        "https://evil.example/fcm.googleapis.com",
        "https://fcm.googleapis.com.evil.example/a",
        "https://evilpush.apple.com/a",
        "https://push.apple.com.evil.example./a",
        "https://user:pw@fcm.googleapis.com/a",
        "https://fcm.googleapis.com:8443/a",
        "not a url",
    ] {
        assert_eq!(valid_endpoint(bad), None, "{bad}");
    }
    let long = format!("https://fcm.googleapis.com/{}", "a".repeat(2048));
    assert_eq!(valid_endpoint(&long), None);
    let limit = format!("https://fcm.googleapis.com/{}", "a".repeat(2048 - "https://fcm.googleapis.com/".len()));
    assert_eq!(valid_endpoint(&limit).as_deref(), Some(limit.as_str()));
}

// ---- send validation ----

#[test]
fn a_payload_is_base64url_of_one_to_4096_bytes() {
    let body = |text: &str| web_push_body(&json!(text));
    assert_eq!(body("aGk"), Some(b"hi".to_vec()));
    assert_eq!(body("-_8"), Some(vec![0xfb, 0xff]));
    // The unused bits of the last character are ignored, as `Buffer.from(text, 'base64url')` does.
    assert_eq!(body("aGl"), Some(b"hi".to_vec()));
    // A dangling single character carries no byte.
    assert_eq!(body("aGlp"), Some(b"hi\x69".to_vec()));
    assert_eq!(body("aGlpa"), Some(b"hii".to_vec()));
    for bad in ["", "a", "a=", "aGk=", "a b", "aGk\n", "+/8", "\u{e9}"] {
        assert_eq!(body(bad), None, "{bad:?}");
    }
    assert_eq!(web_push_body(&json!(7)), None);
    assert_eq!(web_push_body(&Value::Null), None);
    let encode = |len: usize| URL_SAFE_NO_PAD.encode(vec![7u8; len]);
    assert_eq!(body(&encode(4096)).map(|b| b.len()), Some(4096));
    assert_eq!(body(&encode(4097)), None);
    assert_eq!(body(&encode(10_000)), None);
}

#[test]
fn the_options_fall_back_to_their_defaults() {
    let defaults = Options { ttl: 24 * 3600, urgency: "high".to_owned(), topic: String::new() };
    assert_eq!(web_push_options(&json!({})), defaults);
    let given = web_push_options(&json!({ "ttl": 60, "urgency": "low", "topic": "chat_1-A" }));
    assert_eq!(given, Options { ttl: 60, urgency: "low".to_owned(), topic: "chat_1-A".to_owned() });
    assert_eq!(web_push_options(&json!({ "ttl": 0 })).ttl, 0);
    assert_eq!(web_push_options(&json!({ "ttl": 3600.0 })).ttl, 3600);
    assert_eq!(web_push_options(&json!({ "ttl": 28 * 24 * 3600 })).ttl, 28 * 24 * 3600);
    for ttl in [json!(-1), json!(28 * 24 * 3600 + 1), json!(1.5), json!("60"), Value::Null] {
        assert_eq!(web_push_options(&json!({ "ttl": ttl })).ttl, 24 * 3600, "{ttl}");
    }
    for urgency in ["very-low", "low", "normal", "high"] {
        assert_eq!(web_push_options(&json!({ "urgency": urgency })).urgency, urgency);
    }
    assert_eq!(web_push_options(&json!({ "urgency": "urgent" })).urgency, "high");
    for topic in ["", "has space", "a".repeat(33).as_str(), "caf\u{e9}"] {
        assert_eq!(web_push_options(&json!({ "topic": topic })).topic, "", "{topic}");
    }
    assert_eq!(web_push_options(&json!({ "topic": "a".repeat(32) })).topic, "a".repeat(32));
}

// ---- sender ----

#[tokio::test]
async fn the_sender_rechecks_the_endpoint_and_never_posts_outside_the_push_services() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let sender = Sender::new(Arc::new(VapidKeys::load_or_create(dir.path()).unwrap()), service.clone());
    let request = |endpoint: &str| SendRequest { endpoint: endpoint.to_owned(), body: b"x".to_vec(), options: Options::default() };
    for endpoint in ["https://service.internal./x", "https://localhost./x", "https://fcm.googleapis.com./x"] {
        let result = sender.send(request(endpoint)).await;
        assert_eq!((result.ok, result.status, result.error.as_deref()), (false, 0, Some("endpoint-not-allowed")), "{endpoint}");
    }
    assert!(service.posted().is_empty());
    assert!(sender.send(request("https://fcm.googleapis.com/x")).await.ok);
    let posted = service.posted();
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].endpoint, "https://fcm.googleapis.com/x");
}

#[tokio::test]
async fn the_post_carries_the_vapid_header_the_options_and_the_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let keys = VapidKeys::load_or_create(dir.path()).unwrap();
    let public = keys.public_key().to_owned();
    let sender = Sender::new(Arc::new(keys), service.clone());
    let options = Options { ttl: 60, urgency: "low".to_owned(), topic: "chat".to_owned() };
    let sent = sender.send(SendRequest { endpoint: ENDPOINT.to_owned(), body: b"ciphertext".to_vec(), options }).await;
    assert_eq!((sent.ok, sent.status, sent.expired, sent.error), (true, 201, false, None));
    let posted = service.posted();
    let request = &posted[0];
    assert_eq!(request.body, b"ciphertext");
    assert_eq!(verify_vapid(header(request, "Authorization").unwrap(), ENDPOINT), public);
    assert_eq!(header(request, "Content-Encoding"), Some("aes128gcm"));
    assert_eq!(header(request, "Content-Type"), Some("application/octet-stream"));
    assert_eq!(header(request, "TTL"), Some("60"));
    assert_eq!(header(request, "Urgency"), Some("low"));
    assert_eq!(header(request, "Topic"), Some("chat"));
    // No topic: no Topic header.
    sender.send(SendRequest { endpoint: ENDPOINT.to_owned(), body: b"x".to_vec(), options: Options::default() }).await;
    assert_eq!(header(&service.posted()[1], "Topic"), None);
    assert_eq!(header(&service.posted()[1], "TTL"), Some("86400"));
    assert_eq!(header(&service.posted()[1], "Urgency"), Some("high"));
}

#[tokio::test]
async fn the_push_services_answer_is_read_by_its_status() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let sender = Sender::new(Arc::new(VapidKeys::load_or_create(dir.path()).unwrap()), service.clone());
    for (status, ok, expired) in [
        (200, true, false),
        (201, true, false),
        (299, true, false),
        (400, false, false),
        (404, false, true),
        (410, false, true),
        (429, false, false),
        (500, false, false),
    ] {
        service.respond(status);
        let result = sender.send(SendRequest { endpoint: ENDPOINT.to_owned(), body: b"x".to_vec(), options: Options::default() }).await;
        assert_eq!((result.ok, result.status, result.expired), (ok, status, expired), "{status}");
    }
}

struct Failing;

impl PushClient for Failing {
    fn post(&self, _request: PushRequest) -> PushFuture<'_> {
        Box::pin(async { Err("fetch failed".to_owned()) })
    }
}

#[tokio::test]
async fn a_failed_post_is_a_result_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let sender = Sender::new(Arc::new(VapidKeys::load_or_create(dir.path()).unwrap()), Arc::new(Failing));
    let result = sender.send(SendRequest { endpoint: ENDPOINT.to_owned(), body: b"x".to_vec(), options: Options::default() }).await;
    assert_eq!((result.ok, result.status, result.expired, result.error.as_deref()), (false, 0, false, Some("fetch failed")));
}

// ---- registry ----

#[test]
fn a_sealed_box_is_checked_for_shape() {
    assert!(Sealed::from_value(&sealed_value("a")).is_some());
    let mut broken = sealed_value("a");
    broken["version"] = json!(2);
    assert!(Sealed::from_value(&broken).is_none());
    for (field, value) in [
        ("ephemeralPublicKey", "B".repeat(86)),
        ("nonce", "n".repeat(15)),
        ("ciphertext", "a".repeat(21)),
        ("ciphertext", "a".repeat(513)),
        ("nonce", format!("{}+", "n".repeat(15))),
    ] {
        let mut broken = sealed_value("a");
        broken[field] = json!(value);
        assert!(Sealed::from_value(&broken).is_none(), "{field}");
    }
    assert!(Sealed::from_value(&json!([])).is_none());
    assert!(Sealed::from_value(&Value::Null).is_none());
    let mut ciphertext_limits = sealed_value("a");
    ciphertext_limits["ciphertext"] = json!("a".repeat(512));
    assert!(Sealed::from_value(&ciphertext_limits).is_some());
}

#[test]
fn associations_are_persisted_and_each_pc_sees_only_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path());
    assert_eq!(registry.bind("pc-a", "aaaaaaaa", ENDPOINT, &sealed("a")), Bind::Ok);
    assert_eq!(registry.bind("pc-b", "bbbbbbbb", ENDPOINT, &sealed("b")), Bind::Ok);
    // The same box again writes nothing, a new box refreshes it.
    let unblock = block_registry_writes(dir.path());
    assert_eq!(registry.bind("pc-a", "aaaaaaaa", ENDPOINT, &sealed("a")), Bind::Unchanged);
    unblock();
    assert_eq!(registry.bind("pc-a", "aaaaaaaa", ENDPOINT, &sealed("z")), Bind::Ok);
    let saved: Value = serde_json::from_str(&read(&dir.path().join(SUBSCRIPTIONS_FILE))).unwrap();
    assert_eq!(saved["subscriptions"][0]["associations"].as_array().unwrap().len(), 2);
    assert_eq!(saved["subscriptions"][0]["associations"][0]["sealed"], sealed_value("z"));

    let reloaded = Registry::open(dir.path());
    assert!(reloaded.has("pc-a", "aaaaaaaa", ENDPOINT));
    let rows = reloaded.list_for("pc-a");
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].endpoint.as_str(), rows[0].client_id.as_str()), (ENDPOINT, "aaaaaaaa"));
    assert_eq!(rows[0].to_value()["sealed"], sealed_value("z"));
    assert_eq!(reloaded.list_for("pc-b")[0].sealed, sealed("b"));
    assert!(reloaded.list_for("pc-c").is_empty());
    assert!(!reloaded.has("pc-a", "bbbbbbbb", ENDPOINT));
}

#[test]
fn a_store_that_fails_leaves_memory_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path());
    assert_eq!(registry.bind("pc-a", "aaaaaaaa", ENDPOINT, &sealed("a")), Bind::Ok);
    let unblock = block_registry_writes(dir.path());
    // A removal that would come back on restart is undone and reported as failed.
    assert_eq!(registry.unbind("pc-a", "aaaaaaaa", ENDPOINT), Unbind::StoreFailed);
    assert!(registry.has("pc-a", "aaaaaaaa", ENDPOINT));
    // A new box that cannot be stored is refused the same way, and the old one stays.
    assert_eq!(registry.bind("pc-a", "aaaaaaaa", ENDPOINT, &sealed("z")), Bind::StoreFailed);
    assert_eq!(registry.list_for("pc-a")[0].sealed, sealed("a"));
    // A new association vanishes again, and with it the endpoint it made.
    assert_eq!(registry.bind("pc-b", "bbbbbbbb", "https://fcm.googleapis.com/other", &sealed("b")), Bind::StoreFailed);
    assert!(!registry.has("pc-b", "bbbbbbbb", "https://fcm.googleapis.com/other"));
    assert!(registry.list_for("pc-b").is_empty());
    assert_eq!(registry.mark_capable("pc-a"), Capable::StoreFailed);
    assert!(!registry.is_capable("pc-a"));
    unblock();
    assert_eq!(registry.unbind("pc-a", "aaaaaaaa", ENDPOINT), Unbind::Removed);
    assert_eq!(registry.unbind("pc-a", "aaaaaaaa", ENDPOINT), Unbind::Absent);
    assert!(!Registry::open(dir.path()).has("pc-a", "aaaaaaaa", ENDPOINT));
}

#[test]
fn the_quotas_are_32_per_endpoint_and_64_per_device() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path());
    for index in 0..32 {
        assert_eq!(registry.bind(&format!("pc-{index}"), "aaaaaaaa", ENDPOINT, &sealed("a")), Bind::Ok, "{index}");
    }
    assert_eq!(registry.bind("pc-32", "aaaaaaaa", ENDPOINT, &sealed("a")), Bind::Quota);
    // A refresh of an existing association is not a new one.
    assert_eq!(registry.bind("pc-0", "aaaaaaaa", ENDPOINT, &sealed("b")), Bind::Ok);
    for index in 0..64 {
        let endpoint = format!("https://fcm.googleapis.com/fcm/send/many-{index}");
        assert_eq!(registry.bind("pc-many", "aaaaaaaa", &endpoint, &sealed("a")), Bind::Ok, "{index}");
    }
    assert_eq!(registry.bind("pc-many", "aaaaaaaa", "https://fcm.googleapis.com/fcm/send/one-more", &sealed("a")), Bind::Quota);
    assert_eq!(registry.bind("pc-many", "bbbbbbbb", "https://fcm.googleapis.com/fcm/send/many-0", &sealed("a")), Bind::Quota);
    assert_eq!(registry.list_for("pc-many").len(), 64);
}

#[test]
fn a_pc_delivers_through_the_relay_once_it_says_so_and_is_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path());
    assert!(!registry.is_capable("pc-a"));
    assert_eq!(registry.mark_capable("pc-a"), Capable::Ok);
    assert_eq!(registry.mark_capable("pc-a"), Capable::Unchanged);
    assert_eq!(registry.mark_capable(""), Capable::StoreFailed);
    assert_eq!(registry.mark_capable("has space"), Capable::StoreFailed);
    assert_eq!(registry.mark_capable(&"a".repeat(129)), Capable::StoreFailed);
    let reloaded = Registry::open(dir.path());
    assert!(reloaded.is_capable("pc-a"));
    assert!(!reloaded.is_capable("pc-b"));
}

#[test]
fn a_revoked_client_or_device_loses_its_associations_and_no_others() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path());
    let other = "https://updates.push.services.mozilla.com/wpush/v2/two";
    registry.bind("pc-a", "aaaaaaaa", ENDPOINT, &sealed("a"));
    registry.bind("pc-a", "aaaaaaab", other, &sealed("a"));
    registry.bind("pc-b", "bbbbbbbb", ENDPOINT, &sealed("b"));
    registry.mark_capable("pc-a");
    assert!(!registry.drop_client("pc-a", Some("cccccccc")));
    assert!(registry.drop_client("pc-a", Some("aaaaaaaa")));
    assert!(!registry.has("pc-a", "aaaaaaaa", ENDPOINT));
    assert!(registry.has("pc-a", "aaaaaaab", other));
    assert!(registry.has("pc-b", "bbbbbbbb", ENDPOINT));
    assert!(registry.is_capable("pc-a"), "a revoked client does not make the PC incapable");
    // A revoked device: everything of that PC, and its capability.
    assert!(registry.drop_client("pc-a", None));
    assert!(registry.list_for("pc-a").is_empty());
    assert!(!registry.is_capable("pc-a"));
    let reloaded = Registry::open(dir.path());
    assert!(!reloaded.is_capable("pc-a"));
    assert!(reloaded.has("pc-b", "bbbbbbbb", ENDPOINT));
    // Forgetting only the capability is a change that is stored too.
    let mut registry = Registry::open(dir.path());
    registry.mark_capable("pc-b");
    assert!(!registry.drop_client("pc-c", None));
    registry.drop_client("pc-b", None);
    assert!(!Registry::open(dir.path()).is_capable("pc-b"));
}

#[test]
fn a_retired_endpoint_is_dropped_for_every_pc_and_the_holders_are_named() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path());
    registry.bind("pc-a", "aaaaaaaa", ENDPOINT, &sealed("a"));
    registry.bind("pc-b", "bbbbbbbb", ENDPOINT, &sealed("b"));
    registry.bind("pc-a", "aaaaaaab", ENDPOINT, &sealed("c"));
    assert_eq!(registry.drop_endpoint(ENDPOINT), ["pc-a", "pc-b"]);
    assert!(registry.drop_endpoint(ENDPOINT).is_empty());
    assert!(Registry::open(dir.path()).list_for("pc-a").is_empty());
}

#[test]
fn a_file_that_is_not_json_starts_an_empty_registry() {
    let dir = tempfile::tempdir().unwrap();
    write(&dir.path().join(SUBSCRIPTIONS_FILE), "{not json");
    assert!(Registry::open(dir.path()).list_for("pc-a").is_empty());
}

#[test]
fn a_file_that_is_not_a_registry_object_starts_an_empty_registry() {
    let dir = tempfile::tempdir().unwrap();
    write(&dir.path().join(SUBSCRIPTIONS_FILE), "[1,2]");
    assert!(Registry::open(dir.path()).list_for("pc-a").is_empty());
}

#[test]
fn a_foreign_file_keeps_only_what_is_valid() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SUBSCRIPTIONS_FILE);
    let valid = json!({ "deviceId": "pc-a", "clientId": "aaaaaaaa", "sealed": sealed_value("a"), "createdAt": 5 });
    write(
        &path,
        &json!({
            "version": 1,
            "devices": ["pc-a", "has space", 7, "pc-a"],
            "subscriptions": [
                { "endpoint": "https://evil.example/x", "associations": [valid.clone()] },
                { "endpoint": ENDPOINT, "associations": "no" },
                { "endpoint": ENDPOINT, "associations": [
                    valid,
                    { "deviceId": "pc-a", "clientId": "bbbbbbbb", "sealed": { "version": 2 }, "createdAt": 5 },
                    { "deviceId": 4, "clientId": "cccccccc", "sealed": sealed_value("a") },
                    null
                ] },
                { "endpoint": "https://fcm.googleapis.com/empty", "associations": [] },
                null
            ]
        })
        .to_string(),
    );
    let registry = Registry::open(dir.path());
    assert!(registry.is_capable("pc-a"));
    assert!(!registry.is_capable("has space"));
    assert_eq!(registry.list_for("pc-a").len(), 1);
    assert!(registry.has("pc-a", "aaaaaaaa", ENDPOINT));
    assert!(!registry.has("pc-a", "aaaaaaaa", "https://evil.example/x"));
    assert!(!registry.has("pc-a", "aaaaaaaa", "https://fcm.googleapis.com/empty"));
}

// ---- files as the relay lays them out ----

// Literal file contents in the layout the relay persists.
const NODE_PUBLIC_KEY: &str = r#"BBluyeml-8QDy-0RmD1Qgyev-EhumZNT0lU-kPXBCc4bsjiSm4S28DPhfyd7QgmuQOKnPlED3zFkVTu5ZGMdRYc"#;
const NODE_VAPID_FILE: &str = r#"{
  "version": 1,
  "publicKey": "BBluyeml-8QDy-0RmD1Qgyev-EhumZNT0lU-kPXBCc4bsjiSm4S28DPhfyd7QgmuQOKnPlED3zFkVTu5ZGMdRYc",
  "privateKeyJwk": {
    "kty": "EC",
    "x": "GW7J6aX7xAPL7RGYPVCDJ6_4SG6Zk1PSVT6Q9cEJzhs",
    "y": "sjiSm4S28DPhfyd7QgmuQOKnPlED3zFkVTu5ZGMdRYc",
    "crv": "P-256",
    "d": "He8lIA5luIngE7mxk5FKkuZf23F7WRNTm-4YIGUljLw"
  }
}"#;
const NODE_SUBSCRIPTIONS_FILE: &str = r#"{"version":1,"devices":["pc-a"],"subscriptions":[{"endpoint":"https://fcm.googleapis.com/fcm/send/subscription-1","associations":[{"deviceId":"pc-a","clientId":"aaaaaaaa","sealed":{"version":1,"ephemeralPublicKey":"Baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnn","ciphertext":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"createdAt":1794715228134},{"deviceId":"pc-b","clientId":"bbbbbbbb","sealed":{"version":1,"ephemeralPublicKey":"Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","nonce":"nnnnnnnnnnnnnnnn","ciphertext":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"createdAt":1794715228135}]},{"endpoint":"https://updates.push.services.mozilla.com/wpush/v2/subscription-2","associations":[{"deviceId":"pc-a","clientId":"aaaaaaaa","sealed":{"version":1,"ephemeralPublicKey":"Bcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","nonce":"nnnnnnnnnnnnnnnn","ciphertext":"cccccccccccccccccccccccccccccccccccccccc"},"createdAt":1794715228135}]}]}"#;
const NODE_REWRITTEN_FILE: &str = r#"{"version":1,"devices":["pc-a","pc-b"],"subscriptions":[{"endpoint":"https://fcm.googleapis.com/fcm/send/subscription-1","associations":[{"deviceId":"pc-a","clientId":"aaaaaaaa","sealed":{"version":1,"ephemeralPublicKey":"Baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnn","ciphertext":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"createdAt":1794715228134},{"deviceId":"pc-b","clientId":"bbbbbbbb","sealed":{"version":1,"ephemeralPublicKey":"Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","nonce":"nnnnnnnnnnnnnnnn","ciphertext":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"createdAt":1794715228135}]},{"endpoint":"https://updates.push.services.mozilla.com/wpush/v2/subscription-2","associations":[{"deviceId":"pc-a","clientId":"aaaaaaaa","sealed":{"version":1,"ephemeralPublicKey":"Bcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","nonce":"nnnnnnnnnnnnnnnn","ciphertext":"cccccccccccccccccccccccccccccccccccccccc"},"createdAt":1794715228135}]}]}"#;

#[test]
fn the_vapid_file_is_read_unchanged_and_signs_with_the_same_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(VAPID_FILE);
    write(&path, NODE_VAPID_FILE);
    let keys = VapidKeys::load_or_create(dir.path()).unwrap();
    // Every browser subscription is bound to this public key: reading the file must not change it, or the file.
    assert_eq!(keys.public_key(), NODE_PUBLIC_KEY);
    assert_eq!(read(&path), NODE_VAPID_FILE);
    let authorization = vapid_authorization(ENDPOINT, &keys, VAPID_SUBJECT, mixdog_relay::rate_limit::now_ms()).unwrap();
    assert_eq!(verify_vapid(&authorization, ENDPOINT), NODE_PUBLIC_KEY);
    // Loaded again, still the same.
    assert_eq!(VapidKeys::load_or_create(dir.path()).unwrap().public_key(), NODE_PUBLIC_KEY);
    assert_eq!(read(&path), NODE_VAPID_FILE);
}

#[test]
fn the_subscriptions_file_is_loaded_and_rewritten_in_its_layout() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SUBSCRIPTIONS_FILE);
    write(&path, NODE_SUBSCRIPTIONS_FILE);
    let mut registry = Registry::open(dir.path());
    let mozilla = "https://updates.push.services.mozilla.com/wpush/v2/subscription-2";
    assert!(registry.is_capable("pc-a"));
    assert!(!registry.is_capable("pc-b"));
    let rows = registry.list_for("pc-a");
    assert_eq!(rows.iter().map(|row| row.endpoint.as_str()).collect::<Vec<_>>(), [ENDPOINT, mozilla]);
    assert_eq!(rows[0].sealed, sealed("a"));
    assert_eq!(rows[1].sealed, sealed("c"));
    assert_eq!(registry.list_for("pc-b")[0].sealed, sealed("b"));
    // Loading writes nothing.
    assert_eq!(read(&path), NODE_SUBSCRIPTIONS_FILE);
    // The write after the same load and the same change, byte for byte.
    assert_eq!(registry.mark_capable("pc-b"), Capable::Ok);
    assert_eq!(read(&path), NODE_REWRITTEN_FILE);
    // And Rust reads what it wrote.
    let again = Registry::open(dir.path());
    assert!(again.is_capable("pc-b"));
    assert_eq!(again.list_for("pc-a").len(), 2);
}

// ---- the `webpush-send` flow ----

const PC_A: &str = "0123456789abcdef-a";
const PC_B: &str = "0123456789abcdef-b";

fn two_pcs(dir: &Path, service: &Arc<PushService>) -> WebPush {
    let webpush = WebPush::open(dir, service.clone()).unwrap();
    {
        let mut registry = webpush.registry();
        assert_eq!(registry.bind(PC_A, "aaaaaaaa", ENDPOINT, &sealed("a")), Bind::Ok);
        assert_eq!(registry.bind(PC_B, "bbbbbbbb", ENDPOINT, &sealed("b")), Bind::Ok);
    }
    webpush
}

fn knows_every_client(_device: &str, _client: &str) -> bool {
    true
}

fn send_message(client_id: &str, payload: &str) -> Value {
    json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": client_id, "payload": payload })
}

fn payload(text: &str) -> String {
    URL_SAFE_NO_PAD.encode(text)
}

#[test]
fn the_relay_key_is_the_one_in_the_identity_file_and_each_pc_sees_its_own_box() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let webpush = two_pcs(dir.path(), &service);
    assert_eq!(webpush.public_key(), VapidKeys::load_or_create(dir.path()).unwrap().public_key());
    webpush.mark_ready(PC_A);
    assert!(webpush.registry().is_capable(PC_A));
    assert!(!webpush.registry().is_capable(PC_B));
    let frame = webpush.subscriptions_frame(PC_A, knows_every_client);
    assert_eq!(
        frame,
        json!({ "type": "webpush-subscriptions", "subscriptions": [{ "endpoint": ENDPOINT, "clientId": "aaaaaaaa", "sealed": sealed_value("a") }] })
    );
    // A client the device store no longer knows is left out.
    let frame = webpush.subscriptions_frame(PC_B, |_, client| client != "bbbbbbbb");
    assert_eq!(frame, json!({ "type": "webpush-subscriptions", "subscriptions": [] }));
    assert_eq!(webpush.subscriptions_frame("nobody", knows_every_client)["subscriptions"], json!([]));
}

#[tokio::test]
async fn each_pc_delivers_through_its_own_association_and_a_pc_cannot_borrow_anothers() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let webpush = two_pcs(dir.path(), &service);
    let body = payload("ciphertext-from-a");
    let result_a = webpush.send_from_desktop(PC_A, &send_message("aaaaaaaa", &body), knows_every_client, |_| {}).await;
    assert_eq!(result_a, json!({ "type": "webpush-result", "endpoint": ENDPOINT, "clientId": "aaaaaaaa", "ok": true, "status": 201 }));
    let result_b = webpush.send_from_desktop(PC_B, &send_message("bbbbbbbb", &body), knows_every_client, |_| {}).await;
    assert_eq!(result_b["ok"], json!(true));
    let posted = service.posted();
    assert_eq!(posted.len(), 2);
    assert_eq!(posted[0].endpoint, ENDPOINT);
    assert_eq!(posted[0].body, b"ciphertext-from-a");
    assert_eq!(header(&posted[0], "Content-Encoding"), Some("aes128gcm"));
    assert_eq!(verify_vapid(header(&posted[0], "Authorization").unwrap(), ENDPOINT), webpush.public_key());

    // A PC cannot borrow another PC's association.
    let borrowed = webpush.send_from_desktop(PC_A, &send_message("bbbbbbbb", &body), knows_every_client, |_| {}).await;
    assert_eq!(borrowed, json!({ "type": "webpush-result", "endpoint": ENDPOINT, "clientId": "bbbbbbbb", "ok": false, "error": "unbound-subscription" }));
    // A client the device store no longer knows is refused even with the association.
    let revoked = webpush.send_from_desktop(PC_A, &send_message("aaaaaaaa", &body), |_, _| false, |_| {}).await;
    assert_eq!(revoked["error"], json!("unbound-subscription"));
    assert_eq!(service.posted().len(), 2);
}

#[tokio::test]
async fn a_send_that_is_not_well_formed_is_refused_before_anything_is_posted() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let webpush = two_pcs(dir.path(), &service);
    let good = payload("x");
    let long_endpoint = "e".repeat(3000);
    for message in [
        json!({ "type": "webpush-send" }),
        json!({ "endpoint": ENDPOINT, "clientId": "aaaaaaaa" }),
        json!({ "endpoint": ENDPOINT, "clientId": "aaaaaaaa", "payload": "" }),
        json!({ "endpoint": ENDPOINT, "clientId": "aaaaaaaa", "payload": "not base64!" }),
        json!({ "endpoint": ENDPOINT, "clientId": "aaaaaaaa", "payload": payload(&"x".repeat(4097)) }),
        json!({ "endpoint": 4, "clientId": "aaaaaaaa", "payload": good }),
        json!({ "endpoint": ENDPOINT, "clientId": ["aaaaaaaa"], "payload": good }),
        json!({ "endpoint": "", "clientId": "aaaaaaaa", "payload": good }),
    ] {
        let result = webpush.send_from_desktop(PC_A, &message, knows_every_client, |_| {}).await;
        assert_eq!(result["type"], json!("webpush-result"));
        assert_eq!((result["ok"].clone(), result["error"].clone()), (json!(false), json!("invalid-message")), "{message}");
    }
    // The echoed endpoint and client id are clipped to the frame's limits.
    let result =
        webpush.send_from_desktop(PC_A, &json!({ "endpoint": long_endpoint, "clientId": "c".repeat(300), "payload": good }), knows_every_client, |_| {}).await;
    assert_eq!(result["endpoint"].as_str().unwrap().len(), 2048);
    assert_eq!(result["clientId"].as_str().unwrap().len(), 128);
    assert!(service.posted().is_empty());
}

#[tokio::test]
async fn the_options_of_the_message_reach_the_push_service() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let webpush = two_pcs(dir.path(), &service);
    let mut message = send_message("aaaaaaaa", &payload("x"));
    message["ttl"] = json!(30);
    message["urgency"] = json!("very-low");
    message["topic"] = json!("badge");
    webpush.send_from_desktop(PC_A, &message, knows_every_client, |_| {}).await;
    let posted = service.posted();
    assert_eq!(header(&posted[0], "TTL"), Some("30"));
    assert_eq!(header(&posted[0], "Urgency"), Some("very-low"));
    assert_eq!(header(&posted[0], "Topic"), Some("badge"));
}

#[tokio::test]
async fn a_retired_subscription_is_dropped_for_every_pc_and_each_holder_is_told() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let webpush = two_pcs(dir.path(), &service);
    service.respond(410);
    let told = Mutex::new(Vec::new());
    let result = webpush
        .send_from_desktop(PC_A, &send_message("aaaaaaaa", &payload("x")), knows_every_client, |holder| told.lock().unwrap().push(holder.to_owned()))
        .await;
    assert_eq!(result, json!({ "type": "webpush-result", "endpoint": ENDPOINT, "clientId": "aaaaaaaa", "ok": false, "status": 410, "expired": true }));
    assert_eq!(*told.lock().unwrap(), [PC_A, PC_B]);
    assert!(webpush.registry().list_for(PC_A).is_empty());
    assert!(webpush.registry().list_for(PC_B).is_empty());
    assert!(Registry::open(dir.path()).list_for(PC_B).is_empty());
}

#[tokio::test]
async fn a_pc_may_send_240_times_a_minute() {
    let dir = tempfile::tempdir().unwrap();
    let service = PushService::new();
    let webpush = two_pcs(dir.path(), &service);
    let message = send_message("aaaaaaaa", &payload("x"));
    for index in 0..240 {
        let result = webpush.send_from_desktop(PC_A, &message, knows_every_client, |_| {}).await;
        assert_eq!(result["ok"], json!(true), "{index}");
    }
    let limited = webpush.send_from_desktop(PC_A, &message, knows_every_client, |_| {}).await;
    assert_eq!((limited["ok"].clone(), limited["error"].clone()), (json!(false), json!("rate-limited")));
    assert_eq!(service.posted().len(), 240);
    // Another PC has its own budget.
    let other = webpush.send_from_desktop(PC_B, &send_message("bbbbbbbb", &payload("x")), knows_every_client, |_| {}).await;
    assert_eq!(other["ok"], json!(true));
}

#[tokio::test]
async fn a_failed_post_is_reported_with_its_error_clipped() {
    let dir = tempfile::tempdir().unwrap();
    let webpush = WebPush::open(dir.path(), Arc::new(Failing)).unwrap();
    webpush.registry().bind(PC_A, "aaaaaaaa", ENDPOINT, &sealed("a"));
    let result = webpush.send_from_desktop(PC_A, &send_message("aaaaaaaa", &payload("x")), knows_every_client, |_| {}).await;
    assert_eq!(result, json!({ "type": "webpush-result", "endpoint": ENDPOINT, "clientId": "aaaaaaaa", "ok": false, "error": "fetch failed" }));
}

#[test]
fn mutations_have_their_own_budget_per_credential() {
    let dir = tempfile::tempdir().unwrap();
    let webpush = WebPush::open(dir.path(), PushService::new()).unwrap();
    for index in 0..20 {
        assert!(webpush.allow_mutation("token-a"), "{index}");
    }
    assert!(!webpush.allow_mutation("token-a"));
    assert!(webpush.allow_mutation("token-b"));
}

#[test]
fn web_push_is_off_when_the_identity_is_unusable() {
    let dir = tempfile::tempdir().unwrap();
    write(&dir.path().join(VAPID_FILE), "{}");
    assert!(WebPush::open(dir.path(), PushService::new()).is_none());
}

#[test]
fn capable_devices_the_store_no_longer_knows_are_forgotten_and_stored() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path());
    registry.mark_capable("pc-a");
    registry.mark_capable("pc-b");
    registry.retain_capable(|device_id| device_id == "pc-b");
    assert!(!registry.is_capable("pc-a"));
    let reloaded = Registry::open(dir.path());
    assert!(!reloaded.is_capable("pc-a"));
    assert!(reloaded.is_capable("pc-b"));
}
