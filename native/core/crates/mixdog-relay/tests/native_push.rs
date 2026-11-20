//! Native push: request shapes, token invalidation, token caching, credential forms, bindings per desktop and client, validation and rate limits. The senders run over a recording transport.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicI64, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_relay::js;
use mixdog_relay::native_push::{
    BoxFuture, Clock, HttpRequest, HttpResponse, HttpTransport, MAX_MX_CHARS, NativePush, NativePushService, Origins, PairedClients, Platform, PushMessage,
    PushSender, SendResult, TransportError, parse_ec_p256_pem, parse_rsa_pem, read_apns_config, read_fcm_config,
};
use mixdog_relay::rate_limit::RateLimiter;
use p256::ecdsa::Signature;
use p256::ecdsa::signature::Verifier;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
use serde_json::{Value, json};

// Throwaway keys made for these tests: the same EC key as PKCS#8 and as SEC1, the same RSA key as PKCS#8 and as PKCS#1.
const EC_P8: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgxTs6GHnfdM3qYjWA
ZrQikVUQWS1N4FFALB2waU+O5qOhRANCAAR6Ks2VeVpweqYvCJKCWLUt0OsYAN0E
sgbVPDZXCQq72qW2BN9vjjc4IygEeoBss53AOQyKq7l9fZRm/PgSlKEe
-----END PRIVATE KEY-----
";
const EC_SEC1: &str = "-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIMU7Ohh533TN6mI1gGa0IpFVEFktTeBRQCwdsGlPjuajoAoGCCqGSM49
AwEHoUQDQgAEeirNlXlacHqmLwiSgli1LdDrGADdBLIG1Tw2VwkKu9qltgTfb443
OCMoBHqAbLOdwDkMiqu5fX2UZvz4EpShHg==
-----END EC PRIVATE KEY-----
";
const RSA_P8: &str = "-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDLlG0jKATVQFeA
vvCiHGhfsJxaGxntGdGLNKCxvybombHcM4t7u46cs+mIRG6nSpG5APQ4yDs2FJpB
YYA8OS9OmOJhceXKHAZMvtmF7hc78TNM6fMPd5LnJecr1wDSsmtfXAEWZHlFQnid
IDtACNQM8OOuWhi82ZQzJjA7SyYr7Iy/4X+ACHDIBwkOs1ZjGjXC+i5B2kK+jmHO
/R1+XAmxQHLNKWvBJrB/1AglfKpo8HIxkiJtPZsePSMzp2beRGUnvk+3nQwYpRF5
sTzWblWFH2CZZdanZBALSsXq26dmT2ezMYAHkwyPNQJB9tSPUr5JmQXX2PTZetrA
uZOr1aKJAgMBAAECggEACG85l1WK37f2+CFREHJbW62SSMRrLlDdxuXzC3I3PzdQ
8GXdT07NwY3NrOTi7cDv6SmSNMEM/PhdDLzopnYbEOdSJ8XjhpxjIW5dzkf3Q/dC
EBt4Q8mJN1TxbzZM9S3Jt411CRO4F4fBvgbOFaDYAkI/uKNId5iPJJBeOrKqHfMv
1MKqpUtWJwaLGZXpni8fXvy4v95n0vvFCEPVx+zGrh6InVI4SAdSN+xie5MCeSnk
XxiHVCu9bdCc58Zq+vvBzOth0n40oRiqfwPq5Ex6qNWMi6AfUar5clFSF3brr6GJ
Q5LV2qYOajMR5G0qEfWtm73dFTqAeZe0JSJRIFuW9QKBgQDpcx12OXTDZo9KUxe/
K8qwJDD54Z14T4GA4971/Cix3IzJwhxj7D65WXM9ssSIdicqJ8QenmzWMuA+0Bdr
LBsS1RcWuJg9P2tFxBEM+dk0nJDCWgQJnOPqGqgTtP0CJy/Udgq0sPFGOziTM+no
JarepzMHGgIwhwfEFHH86ynezQKBgQDfPqu4YpqcrqSWiGlLo8J+d9Cndmca9hnR
PaCW7P5SrcRBasNW3StywSgEpdIsccwVPq7WjqBYiWZMswMN4M8LB2AKUIv5RUrm
NZMvTJQYasPOAjlh9MOw0Feb3LmB9ODvOXcVHaWQR7sWaAOXATz/iG0hQ4XyoRx9
zz0HPQ5arQKBgERMv6PlL3ozuVx/bwUpZMWf8QxKq+2VJUh2YrcJLUbMRgyJVBEP
/1HvD75PXRynpNG6jLCAnUsV23HFI/ThFJKv8W9eVnwk39erg2mOd7Pi0p9qAqBl
XHETl3UckKFeoanBV2SCGDT6ApVerOKUkqdNt6ouO9HCz8zYRnk+vCNJAoGARuWz
SUpfSbUY5gmKTxBBu0I3zIcItYJErrPApU28cutmcVQDlzmEC9yV5ev3dE/rfS+7
/L2s5JE2INOU+7pSZnFAKeZsnYxI/hUzmgja22pEps8EBDzkTOnNeN0/OKtZJ//6
9oTEyK5PFw2PXkxxX8GmzrKP/n71+mpvOjZEsb0CgYAjznaOwTpfKFFNTdCV1TH7
FWJRZPbidTaHxNGnEX7gPaNoaVvM6nA56jqizTV//0auWwic8UsH089HL9AXV8u8
RJPbrW4Ba2hs1GN1hL0oiUA4qqIEY4Q2MuQCXIGIDTitepr6psTaIp54xqDwHT6v
uvuRUNSqQ7kLiwPbBr5boQ==
-----END PRIVATE KEY-----
";
const RSA_P1: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAy5RtIygE1UBXgL7wohxoX7CcWhsZ7RnRizSgsb8m6Jmx3DOL
e7uOnLPpiERup0qRuQD0OMg7NhSaQWGAPDkvTpjiYXHlyhwGTL7Zhe4XO/EzTOnz
D3eS5yXnK9cA0rJrX1wBFmR5RUJ4nSA7QAjUDPDjrloYvNmUMyYwO0smK+yMv+F/
gAhwyAcJDrNWYxo1wvouQdpCvo5hzv0dflwJsUByzSlrwSawf9QIJXyqaPByMZIi
bT2bHj0jM6dm3kRlJ75Pt50MGKURebE81m5VhR9gmWXWp2QQC0rF6tunZk9nszGA
B5MMjzUCQfbUj1K+SZkF19j02XrawLmTq9WiiQIDAQABAoIBAAhvOZdVit+39vgh
URByW1utkkjEay5Q3cbl8wtyNz83UPBl3U9OzcGNzazk4u3A7+kpkjTBDPz4XQy8
6KZ2GxDnUifF44acYyFuXc5H90P3QhAbeEPJiTdU8W82TPUtybeNdQkTuBeHwb4G
zhWg2AJCP7ijSHeYjySQXjqyqh3zL9TCqqVLVicGixmV6Z4vH178uL/eZ9L7xQhD
1cfsxq4eiJ1SOEgHUjfsYnuTAnkp5F8Yh1QrvW3QnOfGavr7wczrYdJ+NKEYqn8D
6uRMeqjVjIugH1Gq+XJRUhd266+hiUOS1dqmDmozEeRtKhH1rZu93RU6gHmXtCUi
USBblvUCgYEA6XMddjl0w2aPSlMXvyvKsCQw+eGdeE+BgOPe9fwosdyMycIcY+w+
uVlzPbLEiHYnKifEHp5s1jLgPtAXaywbEtUXFriYPT9rRcQRDPnZNJyQwloECZzj
6hqoE7T9Aicv1HYKtLDxRjs4kzPp6CWq3qczBxoCMIcHxBRx/Osp3s0CgYEA3z6r
uGKanK6klohpS6PCfnfQp3ZnGvYZ0T2gluz+Uq3EQWrDVt0rcsEoBKXSLHHMFT6u
1o6gWIlmTLMDDeDPCwdgClCL+UVK5jWTL0yUGGrDzgI5YfTDsNBXm9y5gfTg7zl3
FR2lkEe7FmgDlwE8/4htIUOF8qEcfc89Bz0OWq0CgYBETL+j5S96M7lcf28FKWTF
n/EMSqvtlSVIdmK3CS1GzEYMiVQRD/9R7w++T10cp6TRuoywgJ1LFdtxxSP04RSS
r/FvXlZ8JN/Xq4Npjnez4tKfagKgZVxxE5d1HJChXqGpwVdkghg0+gKVXqzilJKn
TbeqLjvRws/M2EZ5PrwjSQKBgEbls0lKX0m1GOYJik8QQbtCN8yHCLWCRK6zwKVN
vHLrZnFUA5c5hAvcleXr93RP630vu/y9rOSRNiDTlPu6UmZxQCnmbJ2MSP4VM5oI
2ttqRKbPBAQ85EzpzXjdPzirWSf/+vaExMiuTxcNj15McV/Bps6yj/5+9fpqbzo2
RLG9AoGAI852jsE6XyhRTU3QldUx+xViUWT24nU2h8TRpxF+4D2jaGlbzOpwOeo6
os01f/9GrlsInPFLB9PPRy/QF1fLvEST261uAWtobNRjdYS9KIlAOKqiBGOENjLk
AlyBiA04rXqa+qbE2iKeeMag8B0+r7r7kVDUqkO5C4sD2wa+W6E=
-----END RSA PRIVATE KEY-----
";

const APNS_TOKEN: &str = "abababababababababababababababababababababababababababababababab";
const FCM_TOKEN: &str = "ffffffffffffffffffffffffffffffffffffffff:APA91b-token_x";
const T0: i64 = 1_000_000_000_000;

// ---- a recording transport and clock ----

type Responder = Box<dyn FnMut(usize, &HttpRequest) -> Result<HttpResponse, TransportError> + Send>;

struct Recorder {
    seen: Mutex<Vec<HttpRequest>>,
    closes: AtomicUsize,
    respond: Mutex<Responder>,
}

impl Recorder {
    fn new(respond: impl FnMut(usize, &HttpRequest) -> Result<HttpResponse, TransportError> + Send + 'static) -> Arc<Self> {
        Arc::new(Self { seen: Mutex::new(Vec::new()), closes: AtomicUsize::new(0), respond: Mutex::new(Box::new(respond)) })
    }

    fn requests(&self) -> Vec<HttpRequest> {
        self.seen.lock().unwrap().clone()
    }

    fn closes(&self) -> usize {
        self.closes.load(Ordering::SeqCst)
    }
}

impl HttpTransport for Recorder {
    fn post(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        let outcome = {
            let mut seen = self.seen.lock().unwrap();
            seen.push(request.clone());
            let count = seen.len();
            (self.respond.lock().unwrap())(count, &request)
        };
        Box::pin(async move { outcome })
    }

    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}

fn reply(status: u16, body: &Value) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status, body: body.to_string().into_bytes() })
}

fn empty(status: u16) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status, body: Vec::new() })
}

fn clock(ms: &Arc<AtomicI64>) -> Clock {
    let ms = Arc::clone(ms);
    Arc::new(move || ms.load(Ordering::SeqCst))
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect()
}

fn credentialed(env: &BTreeMap<String, String>, recorder: &Arc<Recorder>, now: &Arc<AtomicI64>) -> NativePush {
    let transport: Arc<dyn HttpTransport> = Arc::clone(recorder) as Arc<dyn HttpTransport>;
    NativePush::new(env, &transport, &Origins::default(), &clock(now))
}

fn header(request: &HttpRequest, name: &str) -> String {
    request.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone()).unwrap_or_default()
}

fn body(request: &HttpRequest) -> Value {
    serde_json::from_slice(&request.body).unwrap()
}

fn decode(segment: &str) -> Value {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).unwrap()).unwrap()
}

fn message(platform: Platform, token: &str) -> PushMessage {
    PushMessage {
        platform,
        token: token.to_owned(),
        mx: "bXg".to_owned(),
        reason: "turn-finished".to_owned(),
        collapse_key: "collapse-1".to_owned(),
        sandbox: Some(false),
    }
}

fn apns_message() -> PushMessage {
    message(Platform::Apns, APNS_TOKEN)
}

fn fcm_message() -> PushMessage {
    message(Platform::Fcm, FCM_TOKEN)
}

fn apns_env() -> BTreeMap<String, String> {
    env(&[("APNS_KEY_P8", EC_P8), ("APNS_KEY_ID", "KEYID12345"), ("APNS_TEAM_ID", "TEAMID1234")])
}

fn service_account(extra: &Value) -> String {
    let mut account = json!({
        "project_id": "mixdog-test",
        "client_email": "push@mixdog-test.iam.gserviceaccount.com",
        "private_key": RSA_P8,
        "token_uri": "https://oauth.example.test/token",
    });
    for (name, value) in extra.as_object().unwrap() {
        account[name] = value.clone();
    }
    account.to_string()
}

fn fcm_env() -> BTreeMap<String, String> {
    env(&[("FCM_SERVICE_ACCOUNT_JSON", &service_account(&json!({})))])
}

fn ok_json() -> Result<HttpResponse, TransportError> {
    reply(200, &json!({ "name": "projects/mixdog-test/messages/1" }))
}

/// Answers the OAuth exchange, and everything else with `answer`.
fn fcm_recorder(answer: impl Fn() -> Result<HttpResponse, TransportError> + Send + 'static) -> Arc<Recorder> {
    Recorder::new(move |_, request| {
        if request.url.starts_with("https://oauth.example.test") { reply(200, &json!({ "access_token": "ya29.token", "expires_in": 3600 })) } else { answer() }
    })
}

fn exchanges(recorder: &Recorder) -> usize {
    recorder.requests().iter().filter(|request| request.url.contains("oauth.example.test")).count()
}

// ---- 1: no credentials ----

#[tokio::test]
async fn no_credentials_no_platform_is_advertised_and_sends_fail_gracefully() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|_, _| empty(200));
    let push = credentialed(&BTreeMap::new(), &recorder, &now);
    assert!(push.platforms().is_empty());
    assert!(!push.is_configured());
    let result = push.send(&apns_message()).await;
    assert!(!result.ok);
    assert_eq!(result.error.as_deref(), Some("platform-unavailable"));
    let broken = credentialed(&env(&[("APNS_KEY_P8", "not a key"), ("APNS_KEY_ID", "a"), ("APNS_TEAM_ID", "b")]), &recorder, &now);
    assert!(broken.platforms().is_empty());
    assert!(recorder.requests().is_empty());
}

// ---- 2-6: APNs ----

#[tokio::test]
async fn apns_request_shape_token_auth_headers_mutable_content_and_no_action_category() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|_, _| empty(200));
    let push = credentialed(&apns_env(), &recorder, &now);
    assert_eq!(push.platforms(), vec!["apns"]);
    let mut approval = apns_message();
    approval.reason = "approval-pending".to_owned();
    assert_eq!(push.send(&approval).await, SendResult { ok: true, status: 200, invalid: false, error: None });
    push.send(&apns_message()).await;
    let seen = recorder.requests();
    let (approval, ordinary) = (&seen[0], &seen[1]);
    assert_eq!(approval.url, format!("https://api.push.apple.com/3/device/{APNS_TOKEN}"));
    assert!(approval.http2_only);
    assert_eq!(header(approval, "apns-topic"), "io.mixdog.app");
    assert_eq!(header(approval, "apns-push-type"), "alert");
    assert_eq!(header(approval, "apns-priority"), "10");
    assert_eq!(header(approval, "apns-collapse-id"), "collapse-1");
    assert_eq!(header(approval, "content-type"), "application/json");
    assert_eq!(header(approval, "apns-expiration"), (T0 / 1000 + 3600).to_string());
    let payload = body(approval);
    assert_eq!(payload["mx"], "bXg");
    assert_eq!(payload["aps"]["mutable-content"], 1);
    assert_eq!(payload["aps"]["sound"], "default");
    // Whether an approval offers Allow is inside the encrypted content, which the relay cannot read.
    assert!(payload["aps"].get("category").is_none());
    assert!(body(ordinary)["aps"].get("category").is_none());
    // The fallback alert carries no session content.
    assert_eq!(payload["aps"]["alert"], json!({ "title": "Mixdog", "body": "\u{1F514}" }));
    let authorization = header(approval, "authorization");
    let token = authorization.strip_prefix("bearer ").expect("bearer scheme");
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(decode(parts[0]), json!({ "alg": "ES256", "kid": "KEYID12345" }));
    assert_eq!(decode(parts[1]), json!({ "iss": "TEAMID1234", "iat": T0 / 1000 }));
    let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).expect("r || s");
    parse_ec_p256_pem(EC_P8).unwrap().verifying_key().verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).expect("a valid ES256 signature");
    // The provider token is reused, not re-signed per push.
    assert_eq!(header(ordinary, "authorization"), authorization);
}

#[tokio::test]
async fn apns_410_reports_the_token_invalid_other_failures_do_not() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder =
        Recorder::new(
            |count, _| {
                if count == 1 { reply(410, &json!({ "reason": "Unregistered" })) } else { reply(429, &json!({ "reason": "TooManyRequests" })) }
            },
        );
    let push = credentialed(&apns_env(), &recorder, &now);
    let gone = push.send(&apns_message()).await;
    assert!(!gone.ok);
    assert!(gone.invalid);
    assert_eq!(gone.error.as_deref(), Some("Unregistered"));
    let busy = push.send(&apns_message()).await;
    assert!(!busy.ok);
    assert!(!busy.invalid);
    assert_eq!((busy.status, busy.error.as_deref()), (429, Some("TooManyRequests")));
}

#[tokio::test]
async fn apns_reason_unregistered_is_invalid_without_a_410_and_a_bare_status_names_itself() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|count, _| if count == 1 { reply(400, &json!({ "reason": "Unregistered" })) } else { empty(500) });
    let push = credentialed(&apns_env(), &recorder, &now);
    assert!(push.send(&apns_message()).await.invalid);
    let bare = push.send(&apns_message()).await;
    assert_eq!((bare.invalid, bare.error.as_deref()), (false, Some("http 500")));
}

#[tokio::test]
async fn apns_sandbox_tokens_go_to_the_sandbox_host() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|_, _| empty(200));
    let push = credentialed(&apns_env(), &recorder, &now);
    let mut sandbox = apns_message();
    sandbox.sandbox = Some(true);
    push.send(&sandbox).await;
    push.send(&apns_message()).await;
    let seen = recorder.requests();
    assert_eq!(seen[0].url, format!("https://api.sandbox.push.apple.com/3/device/{APNS_TOKEN}"));
    assert_eq!(seen[1].url, format!("https://api.push.apple.com/3/device/{APNS_TOKEN}"));
}

#[tokio::test]
async fn apns_environment_decides_only_for_a_registration_that_did_not_say() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|_, _| empty(200));
    let mut environment = apns_env();
    environment.insert("APNS_ENVIRONMENT".to_owned(), " Sandbox ".to_owned());
    let push = credentialed(&environment, &recorder, &now);
    let mut unsaid = apns_message();
    unsaid.sandbox = None;
    push.send(&unsaid).await;
    push.send(&apns_message()).await;
    let seen = recorder.requests();
    assert!(seen[0].url.starts_with("https://api.sandbox.push.apple.com/"));
    assert!(seen[1].url.starts_with("https://api.push.apple.com/"));
}

#[tokio::test]
async fn apns_reuses_the_provider_jwt_until_it_expires_or_is_refused() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|count, _| if count == 3 { reply(403, &json!({ "reason": "ExpiredProviderToken" })) } else { empty(200) });
    let push = credentialed(&apns_env(), &recorder, &now);
    push.send(&apns_message()).await;
    push.send(&apns_message()).await;
    let auth = |index: usize| header(&recorder.requests()[index], "authorization");
    assert_eq!(auth(1), auth(0));
    // Past the 40 minute TTL a new JWT is signed.
    now.fetch_add(41 * 60_000, Ordering::SeqCst);
    push.send(&apns_message()).await;
    assert_ne!(auth(2), auth(0));
    // The 403 answering the third request invalidates the cached JWT.
    assert_eq!(recorder.requests().len(), 3);
    now.fetch_add(1000, Ordering::SeqCst);
    push.send(&apns_message()).await;
    assert_ne!(auth(3), auth(2));
}

#[tokio::test]
async fn apns_close_drops_the_connections_and_a_later_send_reconnects() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|_, _| empty(200));
    let push = credentialed(&apns_env(), &recorder, &now);
    push.send(&apns_message()).await;
    assert_eq!(recorder.closes(), 0);
    push.close();
    assert_eq!(recorder.closes(), 1);
    assert!(push.send(&apns_message()).await.ok);
    assert_eq!(recorder.requests().len(), 2);
}

#[tokio::test]
async fn a_transport_failure_is_a_failed_result_not_a_panic_and_a_timeout_says_so() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder =
        Recorder::new(|count, _| if count == 1 { Err(TransportError::Timeout) } else { Err(TransportError::Failed("connect ECONNREFUSED".to_owned())) });
    let push = credentialed(&apns_env(), &recorder, &now);
    assert_eq!(push.send(&apns_message()).await, SendResult { ok: false, status: 0, invalid: false, error: Some("APNs request timed out".to_owned()) });
    assert_eq!(push.send(&apns_message()).await.error.as_deref(), Some("connect ECONNREFUSED"));
}

// ---- 7-9: FCM ----

#[tokio::test]
async fn fcm_request_shape_service_account_jwt_exchange_data_only_high_priority_message() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = fcm_recorder(ok_json);
    let push = credentialed(&fcm_env(), &recorder, &now);
    assert_eq!(push.platforms(), vec!["fcm"]);
    assert!(push.send(&fcm_message()).await.ok);
    push.send(&fcm_message()).await;
    // One token exchange, two sends.
    assert_eq!(exchanges(&recorder), 1);
    let seen = recorder.requests();
    let form: HashMap<String, String> = url::form_urlencoded::parse(&seen[0].body).into_owned().collect();
    assert_eq!(seen[0].url, "https://oauth.example.test/token");
    assert_eq!(header(&seen[0], "content-type"), "application/x-www-form-urlencoded");
    assert_eq!(form["grant_type"], "urn:ietf:params:oauth:grant-type:jwt-bearer");
    let parts: Vec<&str> = form["assertion"].split('.').collect();
    assert_eq!(decode(parts[0]), json!({ "alg": "RS256", "typ": "JWT" }));
    assert_eq!(
        decode(parts[1]),
        json!({
            "iss": "push@mixdog-test.iam.gserviceaccount.com",
            "scope": "https://www.googleapis.com/auth/firebase.messaging",
            "aud": "https://oauth.example.test/token",
            "iat": T0 / 1000,
            "exp": T0 / 1000 + 3600,
        })
    );
    let pair = parse_rsa_pem(RSA_P8).unwrap();
    UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, pair.public().as_ref())
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
        .expect("a valid RS256 signature");
    let send = &seen[1];
    assert_eq!(send.url, "https://fcm.googleapis.com/v1/projects/mixdog-test/messages:send");
    assert!(!send.http2_only);
    assert_eq!(header(send, "authorization"), "Bearer ya29.token");
    let sent = body(send);
    let message = &sent["message"];
    assert_eq!(message["token"], FCM_TOKEN);
    assert_eq!(message["data"], json!({ "mx": "bXg", "reason": "turn-finished" }));
    assert_eq!(message["android"], json!({ "priority": "HIGH", "collapse_key": "collapse-1", "ttl": "3600s" }));
    assert!(message.get("notification").is_none());
}

#[tokio::test]
async fn fcm_access_token_is_cached_until_near_expiry_or_a_401() {
    let now = Arc::new(AtomicI64::new(T0));
    let status = Arc::new(AtomicU16::new(200));
    let answer = Arc::clone(&status);
    let recorder = fcm_recorder(move || reply(answer.load(Ordering::SeqCst), &json!({})));
    let push = credentialed(&fcm_env(), &recorder, &now);
    assert_eq!(exchanges(&recorder), 0);
    push.send(&fcm_message()).await;
    push.send(&fcm_message()).await;
    assert_eq!(exchanges(&recorder), 1);
    now.fetch_add(3_600_000 - 30_000, Ordering::SeqCst);
    push.send(&fcm_message()).await;
    assert_eq!(exchanges(&recorder), 2);
    status.store(401, Ordering::SeqCst);
    push.send(&fcm_message()).await;
    status.store(200, Ordering::SeqCst);
    push.send(&fcm_message()).await;
    assert_eq!(exchanges(&recorder), 3);
}

#[tokio::test]
async fn fcm_unregistered_reports_the_token_invalid() {
    let now = Arc::new(AtomicI64::new(T0));
    let listed = fcm_recorder(|| reply(404, &json!({ "error": { "code": 404, "status": "NOT_FOUND", "details": [{ "errorCode": "UNREGISTERED" }] } })));
    let push = credentialed(&fcm_env(), &listed, &now);
    let result = push.send(&fcm_message()).await;
    assert!(!result.ok);
    assert!(result.invalid);
    assert_eq!(result.error.as_deref(), Some("NOT_FOUND"));
    // A 404 that names nothing is not a dead token; nor is a NOT_FOUND on another status.
    let other = fcm_recorder(|| reply(404, &json!({ "error": { "status": "INVALID_ARGUMENT" } })));
    assert!(!credentialed(&fcm_env(), &other, &now).send(&fcm_message()).await.invalid);
    let not_404 = fcm_recorder(|| reply(400, &json!({ "error": { "status": "NOT_FOUND" } })));
    assert!(!credentialed(&fcm_env(), &not_404, &now).send(&fcm_message()).await.invalid);
}

#[tokio::test]
async fn a_failed_token_exchange_is_a_failed_send() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|_, _| reply(400, &json!({ "error": "invalid_grant" })));
    let push = credentialed(&fcm_env(), &recorder, &now);
    let result = push.send(&fcm_message()).await;
    assert_eq!((result.ok, result.status, result.error.as_deref()), (false, 0, Some("FCM token exchange failed (400)")));
    assert_eq!(recorder.requests().len(), 1);
}

// ---- credentials ----

#[test]
fn every_supported_private_key_form_parses() {
    let p8 = parse_ec_p256_pem(EC_P8).expect("PKCS#8 EC");
    let sec1 = parse_ec_p256_pem(EC_SEC1).expect("SEC1 EC");
    assert_eq!(p8.verifying_key(), sec1.verifying_key());
    // `openssl ecparam -genkey` writes the curve parameters before the key; the key block is the one read.
    let with_parameters = format!("-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n{EC_SEC1}");
    assert_eq!(parse_ec_p256_pem(&with_parameters).expect("SEC1 EC after its parameters").verifying_key(), p8.verifying_key());
    let p8 = parse_rsa_pem(RSA_P8).expect("PKCS#8 RSA");
    let p1 = parse_rsa_pem(RSA_P1).expect("PKCS#1 RSA");
    assert_eq!(p8.public().as_ref(), p1.public().as_ref());
    // A key of the other kind, or not a key, is unusable.
    assert!(parse_ec_p256_pem(RSA_P8).is_err());
    assert!(parse_rsa_pem(EC_P8).is_err());
    assert!(parse_ec_p256_pem("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n").is_err());
    assert!(parse_ec_p256_pem("not a key").is_err());
}

#[test]
fn apns_credentials_come_inline_or_from_a_file_with_their_defaults() {
    assert!(read_apns_config(&BTreeMap::new()).unwrap().is_none());
    let inline = read_apns_config(&env(&[("APNS_KEY_P8", EC_SEC1)])).unwrap().expect("inline SEC1");
    assert_eq!((inline.key_id.as_str(), inline.team_id.as_str(), inline.topic.as_str()), ("6S9P5W53QC", "Q6C35DQU78", "io.mixdog.app"));
    assert!(!inline.sandbox_default);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("AuthKey.p8");
    mixdog_fsio::write(&mixdog_fsio::Unlaned, &path, EC_P8).unwrap();
    let from_file = read_apns_config(&env(&[
        ("APNS_KEY_P8", path.to_str().unwrap()),
        ("APNS_KEY_ID", " KEY2 "),
        ("APNS_TEAM_ID", "TEAM2"),
        ("APNS_TOPIC", "io.example.app"),
        ("APNS_ENVIRONMENT", "SANDBOX"),
    ]))
    .unwrap()
    .expect("a path");
    assert_eq!((from_file.key_id.as_str(), from_file.team_id.as_str(), from_file.topic.as_str()), ("KEY2", "TEAM2", "io.example.app"));
    assert!(from_file.sandbox_default);
    let missing = read_apns_config(&env(&[("APNS_KEY_P8", "no/such/file.p8")]));
    assert_eq!(missing.err().as_deref(), Some("ENOENT: no such file or directory, open 'no/such/file.p8'"));
}

#[test]
fn fcm_credentials_come_inline_or_from_a_file_and_a_partial_account_disables_nothing_loudly() {
    assert!(read_fcm_config(&BTreeMap::new()).unwrap().is_none());
    let inline = read_fcm_config(&fcm_env()).unwrap().expect("inline JSON");
    assert_eq!((inline.project_id.as_str(), inline.token_uri.as_str()), ("mixdog-test", "https://oauth.example.test/token"));
    let default_uri = read_fcm_config(&env(&[("FCM_SERVICE_ACCOUNT_JSON", &service_account(&json!({ "token_uri": "" })))])).unwrap().unwrap();
    assert_eq!(default_uri.token_uri, "https://oauth2.googleapis.com/token");
    let pkcs1 = read_fcm_config(&env(&[("FCM_SERVICE_ACCOUNT_JSON", &service_account(&json!({ "private_key": RSA_P1 })))])).unwrap();
    assert!(pkcs1.is_some());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("service-account.json");
    mixdog_fsio::write(&mixdog_fsio::Unlaned, &path, service_account(&json!({}))).unwrap();
    assert!(read_fcm_config(&env(&[("FCM_SERVICE_ACCOUNT_JSON", path.to_str().unwrap())])).unwrap().is_some());
    // No project, no e-mail or no key: the platform is simply off.
    for field in ["project_id", "client_email", "private_key"] {
        let partial = env(&[("FCM_SERVICE_ACCOUNT_JSON", &service_account(&json!({ field: "" })))]);
        assert!(read_fcm_config(&partial).unwrap().is_none(), "{field}");
    }
    assert!(read_fcm_config(&env(&[("FCM_SERVICE_ACCOUNT_JSON", "{ not json")])).is_err());
    assert!(read_fcm_config(&env(&[("FCM_SERVICE_ACCOUNT_JSON", &service_account(&json!({ "private_key": "nope" })))])).is_err());
}

#[test]
fn unusable_credentials_disable_only_that_platform() {
    let now = Arc::new(AtomicI64::new(T0));
    let recorder = Recorder::new(|_, _| empty(200));
    let mut environment = fcm_env();
    environment.insert("APNS_KEY_P8".to_owned(), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----".to_owned());
    assert_eq!(credentialed(&environment, &recorder, &now).platforms(), vec!["fcm"]);
    let mut environment = apns_env();
    environment.insert("FCM_SERVICE_ACCOUNT_JSON".to_owned(), "{ not json".to_owned());
    assert_eq!(credentialed(&environment, &recorder, &now).platforms(), vec!["apns"]);
    let mut both = apns_env();
    both.extend(fcm_env());
    assert_eq!(credentialed(&both, &recorder, &now).platforms(), vec!["apns", "fcm"]);
}

// ---- desktop legs: capability, auth binding, cleanup ----

struct Paired(Mutex<HashMap<String, Vec<String>>>);

impl Paired {
    fn of(pairs: Vec<(&str, Vec<&str>)>) -> Self {
        Self(Mutex::new(pairs.into_iter().map(|(device, clients)| (device.to_owned(), clients.into_iter().map(str::to_owned).collect())).collect()))
    }

    fn set(&self, device: &str, clients: &[&str]) {
        self.0.lock().unwrap().insert(device.to_owned(), clients.iter().map(|c| (*c).to_owned()).collect());
    }
}

impl PairedClients for Paired {
    fn has_client(&self, device_id: &str, client_id: &str) -> bool {
        self.0.lock().unwrap().get(device_id).is_some_and(|clients| clients.iter().any(|client| client == client_id))
    }
}

struct FakePush {
    platforms: Vec<&'static str>,
    result: SendResult,
    sent: Mutex<Vec<PushMessage>>,
}

impl FakePush {
    fn new(platforms: &[&'static str], result: SendResult) -> Arc<Self> {
        Arc::new(Self { platforms: platforms.to_vec(), result, sent: Mutex::new(Vec::new()) })
    }

    fn sent(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}

impl PushSender for FakePush {
    fn platforms(&self) -> Vec<&'static str> {
        self.platforms.clone()
    }

    fn send<'a>(&'a self, message: &'a PushMessage) -> BoxFuture<'a, SendResult> {
        self.sent.lock().unwrap().push(message.clone());
        let result = self.result.clone();
        Box::pin(async move { result })
    }

    fn close(&self) {}
}

fn delivered() -> SendResult {
    SendResult { ok: true, status: 200, invalid: false, error: None }
}

fn service(push: &Arc<FakePush>) -> NativePushService {
    NativePushService::new(Some(Arc::clone(push) as Arc<dyn PushSender>))
}

fn merged(base: Value, extra: &Value) -> Value {
    let mut frame = base;
    for (name, value) in extra.as_object().unwrap() {
        frame[name] = value.clone();
    }
    frame
}

fn send_frame(extra: &Value) -> Value {
    merged(
        json!({ "type": "native-push", "platform": "apns", "token": APNS_TOKEN, "mx": "bXg", "reason": "turn-finished", "collapseKey": "c1", "sandbox": false }),
        extra,
    )
}

fn bind_frame(extra: &Value) -> Value {
    merged(json!({ "type": "native-push-bind", "clientId": "client-1", "platform": "apns", "token": APNS_TOKEN }), extra)
}

async fn sent_error(service: &NativePushService, device: &str, paired: &Paired, frame: &Value) -> Value {
    service.send(device, paired, frame).await.expect("a result frame")["error"].clone()
}

#[test]
fn capabilities_follow_the_credentials() {
    // `relay-capabilities` carries nativePush and the platforms only when the relay can deliver.
    assert!(NativePushService::new(None).platforms().is_empty());
    let push = FakePush::new(&["apns"], delivered());
    assert_eq!(service(&push).platforms(), vec!["apns"]);
}

#[tokio::test]
async fn only_the_desktop_that_bound_a_token_to_its_own_paired_client_can_send_to_it() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"]), ("dev-b", vec!["client-9"])]);
    let push = FakePush::new(&["apns", "fcm"], delivered());
    let service = service(&push);

    assert_eq!(sent_error(&service, "dev-a", &paired, &send_frame(&json!({}))).await, "unbound-token");

    // A client the desktop does not own cannot be bound.
    service.bind("dev-a", &paired, &bind_frame(&json!({ "clientId": "client-9" })));
    assert_eq!(sent_error(&service, "dev-a", &paired, &send_frame(&json!({}))).await, "unbound-token");

    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    let frame = service.send("dev-a", &paired, &send_frame(&json!({}))).await.unwrap();
    assert_eq!(push.sent(), 1);
    assert_eq!(frame, json!({ "type": "native-push-result", "platform": "apns", "token": APNS_TOKEN, "collapseKey": "c1", "ok": true, "status": 200 }));
    assert_eq!(
        js::wire(&frame),
        format!(r#"{{"type":"native-push-result","platform":"apns","token":"{APNS_TOKEN}","collapseKey":"c1","ok":true,"status":200}}"#)
    );

    // Another device cannot send through A's association, nor bind a client it does not own.
    assert_eq!(sent_error(&service, "dev-b", &paired, &send_frame(&json!({}))).await, "unbound-token");
    service.bind("dev-b", &paired, &bind_frame(&json!({ "clientId": "client-1" })));
    assert_eq!(sent_error(&service, "dev-b", &paired, &send_frame(&json!({}))).await, "unbound-token");
    assert_eq!(push.sent(), 1);
}

#[tokio::test]
async fn one_phone_token_paired_with_two_desktops_both_deliver_and_revoking_one_leaves_the_other() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"]), ("dev-b", vec!["client-9"])]);
    let push = FakePush::new(&["apns", "fcm"], delivered());
    let service = service(&push);
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    service.bind("dev-b", &paired, &bind_frame(&json!({ "clientId": "client-9" })));
    let a = service.send("dev-a", &paired, &send_frame(&json!({}))).await.unwrap();
    let b = service.send("dev-b", &paired, &send_frame(&json!({}))).await.unwrap();
    assert_eq!((push.sent(), a["ok"].clone(), b["ok"].clone()), (2, json!(true), json!(true)));

    // A re-binding does not take B's association over (no last-writer-wins).
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    assert_eq!(service.send("dev-b", &paired, &send_frame(&json!({}))).await.unwrap()["ok"], true);
    assert_eq!(push.sent(), 3);

    // A unbinds: only A's association goes.
    service.unbind("dev-a", &json!({ "type": "native-push-unbind", "token": APNS_TOKEN }));
    assert_eq!(sent_error(&service, "dev-a", &paired, &send_frame(&json!({}))).await, "unbound-token");
    assert_eq!(service.send("dev-b", &paired, &send_frame(&json!({}))).await.unwrap()["ok"], true);
    assert_eq!(push.sent(), 4);

    // A re-binds, then its pairing is revoked: B still delivers.
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    paired.set("dev-a", &[]);
    service.drop_bindings("dev-a", Some("client-1"));
    assert_eq!(sent_error(&service, "dev-a", &paired, &send_frame(&json!({}))).await, "unbound-token");
    assert_eq!(service.send("dev-b", &paired, &send_frame(&json!({}))).await.unwrap()["ok"], true);
    assert_eq!(push.sent(), 5);
    assert_eq!(service.association_count(APNS_TOKEN), Some(1));

    // A desktop that never bound the token is still rejected.
    paired.set("dev-c", &["client-5"]);
    assert_eq!(sent_error(&service, "dev-c", &paired, &send_frame(&json!({}))).await, "unbound-token");
    assert_eq!(push.sent(), 5);
}

#[tokio::test]
async fn unpairing_a_client_drops_its_bindings_and_a_stale_binding_can_be_rebound() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"]), ("dev-b", vec!["client-9"])]);
    let push = FakePush::new(&["apns", "fcm"], delivered());
    let service = service(&push);
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    paired.set("dev-a", &[]);
    // The paired client is gone from the store: the binding is dead even though it lingers.
    assert_eq!(sent_error(&service, "dev-a", &paired, &send_frame(&json!({}))).await, "unbound-token");
    service.bind("dev-b", &paired, &bind_frame(&json!({ "clientId": "client-9" })));
    assert_eq!(service.send("dev-b", &paired, &send_frame(&json!({}))).await.unwrap()["ok"], true);
    assert_eq!(push.sent(), 1);
}

#[tokio::test]
async fn unbind_without_a_client_id_drops_every_association_of_this_desktop_only() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1", "client-2"]), ("dev-b", vec!["client-9"])]);
    let push = FakePush::new(&["apns"], delivered());
    let service = service(&push);
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    service.bind("dev-a", &paired, &bind_frame(&json!({ "clientId": "client-2" })));
    service.bind("dev-b", &paired, &bind_frame(&json!({ "clientId": "client-9" })));
    assert_eq!(service.association_count(APNS_TOKEN), Some(3));
    service.unbind("dev-a", &json!({ "token": APNS_TOKEN, "clientId": "client-1" }));
    assert_eq!(service.association_count(APNS_TOKEN), Some(2));
    service.unbind("dev-a", &json!({ "token": 5 }));
    service.unbind("dev-a", &json!({ "token": APNS_TOKEN }));
    assert_eq!(service.association_count(APNS_TOKEN), Some(1));
    service.drop_bindings("dev-b", None);
    assert_eq!(service.association_count(APNS_TOKEN), None);
}

#[tokio::test]
async fn invalid_tokens_reported_by_the_platform_are_dropped_and_the_desktop_is_told() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"])]);
    let push = FakePush::new(&["apns"], SendResult { ok: false, status: 410, invalid: true, error: Some("Unregistered".to_owned()) });
    let service = service(&push);
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    let frame = service.send("dev-a", &paired, &send_frame(&json!({}))).await.unwrap();
    assert_eq!(
        frame,
        json!({ "type": "native-push-result", "platform": "apns", "token": APNS_TOKEN, "collapseKey": "c1", "ok": false, "status": 410, "invalid": true, "error": "Unregistered" })
    );
    assert_eq!(service.association_count(APNS_TOKEN), None);
}

#[tokio::test]
async fn invalid_tokens_drop_only_the_senders_associations() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"]), ("dev-b", vec!["client-9"])]);
    let push = FakePush::new(&["apns"], SendResult { ok: false, status: 410, invalid: true, error: None });
    let service = service(&push);
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    service.bind("dev-b", &paired, &bind_frame(&json!({ "clientId": "client-9" })));
    service.send("dev-a", &paired, &send_frame(&json!({}))).await.unwrap();
    assert_eq!(service.association_count(APNS_TOKEN), Some(1));
}

#[tokio::test]
async fn sends_are_validated_and_rate_limited_per_device() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"])]);
    let push = FakePush::new(&["apns", "fcm"], delivered());
    let service = NativePushService::with_limiter(Some(Arc::clone(&push) as Arc<dyn PushSender>), RateLimiter::new(2, 60_000));
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    for extra in [json!({ "mx": "x".repeat(4000) }), json!({ "reason": "weird" }), json!({ "collapseKey": "bad key!" })] {
        let frame = service.send("dev-a", &paired, &send_frame(&extra)).await.unwrap();
        assert_eq!(frame["error"], "invalid-message");
        assert_eq!(frame["ok"], false);
    }
    assert_eq!(push.sent(), 0);
    let mut errors = Vec::new();
    for _ in 0..3 {
        errors.push(service.send("dev-a", &paired, &send_frame(&json!({}))).await.unwrap().get("error").cloned());
    }
    assert_eq!(errors, vec![None, None, Some(json!("rate-limited"))]);
    assert_eq!(push.sent(), 2);
}

#[tokio::test]
async fn every_malformed_send_is_an_invalid_message_and_the_frame_echoes_only_what_it_had() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"])]);
    let push = FakePush::new(&["apns"], delivered());
    let service = service(&push);
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    for extra in [
        json!({ "platform": "fcm" }),
        json!({ "platform": "web" }),
        json!({ "token": "zz" }),
        json!({ "token": "a".repeat(401) }),
        json!({ "mx": "" }),
        json!({ "mx": 5 }),
        json!({ "collapseKey": "" }),
        json!({ "collapseKey": "k".repeat(65) }),
        json!({ "reason": null }),
    ] {
        let frame = service.send("dev-a", &paired, &send_frame(&extra)).await.unwrap();
        assert_eq!(frame["error"], "invalid-message", "{extra}");
    }
    let bare = service.send("dev-a", &paired, &json!({ "type": "native-push" })).await.unwrap();
    assert_eq!(bare, json!({ "type": "native-push-result", "ok": false, "error": "invalid-message" }));
    assert_eq!(js::wire(&bare), r#"{"type":"native-push-result","ok":false,"error":"invalid-message"}"#);
    assert_eq!(push.sent(), 0);
}

#[tokio::test]
async fn mx_is_limited_in_utf16_code_units_and_the_error_text_is_clipped_to_80_units() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"])]);
    let clipped = SendResult { ok: false, status: 500, invalid: false, error: Some(format!("{}\u{1F600}", "a".repeat(79))) };
    let push = FakePush::new(&["apns"], clipped);
    let service = service(&push);
    service.bind("dev-a", &paired, &bind_frame(&json!({})));
    // 1750 emoji are 3500 code units; one more is 3502.
    let fits = service.send("dev-a", &paired, &send_frame(&json!({ "mx": "\u{1F600}".repeat(MAX_MX_CHARS / 2) }))).await.unwrap();
    assert_ne!(fits["error"], "invalid-message");
    let over = service.send("dev-a", &paired, &send_frame(&json!({ "mx": "\u{1F600}".repeat(MAX_MX_CHARS / 2 + 1) }))).await.unwrap();
    assert_eq!(over["error"], "invalid-message");
    // The 80th unit cuts the emoji in two: the lone high surrogate goes out as the escape JSON.stringify writes.
    let text = js::wire(&fits);
    assert!(text.ends_with(&format!(r#""error":"{}\ud83d"}}"#, "a".repeat(79))), "{text}");
}

#[tokio::test]
async fn a_token_cannot_hold_more_than_64_associations_per_desktop() {
    let clients: Vec<String> = (0..70).map(|n| format!("client-{n}")).collect();
    let client_refs: Vec<&str> = clients.iter().map(String::as_str).collect();
    let paired = Paired::of(vec![("dev-a", client_refs)]);
    let push = FakePush::new(&["apns"], delivered());
    let service = service(&push);
    for client in &clients {
        service.bind("dev-a", &paired, &bind_frame(&json!({ "clientId": client })));
    }
    assert_eq!(service.association_count(APNS_TOKEN), Some(64));
    // An association already held can still be refreshed at the limit.
    service.bind("dev-a", &paired, &bind_frame(&json!({ "clientId": "client-0" })));
    assert_eq!(service.association_count(APNS_TOKEN), Some(64));
}

#[tokio::test]
async fn a_relay_without_credentials_ignores_native_push_frames() {
    let paired = Paired::of(vec![("dev-a", vec!["client-1"])]);
    let bare = NativePushService::new(None);
    bare.bind("dev-a", &paired, &bind_frame(&json!({})));
    assert!(bare.send("dev-a", &paired, &send_frame(&json!({}))).await.is_none());
    assert_eq!(bare.association_count(APNS_TOKEN), None);
    // A sender that serves no platform is no sender: the frame is ignored, not refused.
    let idle = FakePush::new(&[], delivered());
    assert!(service(&idle).send("dev-a", &paired, &send_frame(&json!({}))).await.is_none());
    assert_eq!(idle.sent(), 0);
}
