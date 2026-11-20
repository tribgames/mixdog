//! Sending one already-encrypted web push message (`webPushBody`, `webPushOptions`, `createWebPushSender` of
//! `lib/web-push.mjs`): the validation of what a desktop asks for, the POST to the push service with the VAPID header, and what
//! its answer means. The relay never sees notification content: the desktop encrypts each payload for the subscription
//! (RFC 8291 aes128gcm) and the relay signs the VAPID JWT and posts the ciphertext.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::Value;

use super::endpoint::valid_endpoint;
use super::vapid::{VAPID_SUBJECT, VapidKeys, vapid_authorization};
use crate::rate_limit::now_ms;

pub const DEFAULT_TTL_SECONDS: u64 = 24 * 60 * 60;
pub const MAX_TTL_SECONDS: u64 = 28 * 24 * 60 * 60;
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// One aes128gcm record: the push services cap a message at 4 KB.
pub const MAX_BODY_BYTES: usize = 4096;
/// The longest base64url text that still decodes to [`MAX_BODY_BYTES`]: 4096 bytes are 5462 characters, 4097 need 5463.
const MAX_BODY_CHARS: usize = 5462;
const DEFAULT_URGENCY: &str = "high";

/// `Buffer.from(text, 'base64url')`: lenient about the unused bits of the last character and about a dangling single character.
const LENIENT: GeneralPurpose =
    GeneralPurpose::new(&URL_SAFE, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::RequireNone));

fn is_urgency(value: &str) -> bool {
    matches!(value, "very-low" | "low" | "normal" | "high")
}

/// `^[A-Za-z0-9_-]{1,32}$`.
fn is_topic(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The ciphertext of a `webpush-send` payload: non-empty base64url that decodes to 1..=4096 bytes.
pub fn web_push_body(value: &Value) -> Option<Vec<u8>> {
    let text = value.as_str()?;
    if text.is_empty() || text.len() > MAX_BODY_CHARS || !text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    // A single dangling character carries no whole byte; Node ignores it.
    let whole = if text.len() % 4 == 1 { &text[..text.len() - 1] } else { text };
    let body = LENIENT.decode(whole).ok()?;
    (!body.is_empty() && body.len() <= MAX_BODY_BYTES).then_some(body)
}

/// The delivery options of a `webpush-send`: what is not valid falls back to the default instead of failing the send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub ttl: u64,
    pub urgency: String,
    pub topic: String,
}

impl Default for Options {
    fn default() -> Self {
        Self { ttl: DEFAULT_TTL_SECONDS, urgency: DEFAULT_URGENCY.to_owned(), topic: String::new() }
    }
}

/// `webPushOptions`: `ttl` an integer 0..=28 days (default 24 h), `urgency` very-low|low|normal|high (default high), `topic`
/// `^[A-Za-z0-9_-]{1,32}$` (default none).
pub fn web_push_options(message: &Value) -> Options {
    let ttl = message
        .get("ttl")
        .and_then(Value::as_f64)
        .filter(|ttl| ttl.fract() == 0.0 && (0.0..=MAX_TTL_SECONDS as f64).contains(ttl))
        .map_or(DEFAULT_TTL_SECONDS, |ttl| ttl as u64);
    let urgency = message.get("urgency").and_then(Value::as_str).filter(|urgency| is_urgency(urgency)).unwrap_or(DEFAULT_URGENCY);
    let topic = message.get("topic").and_then(Value::as_str).filter(|topic| is_topic(topic)).unwrap_or_default();
    Options { ttl, urgency: urgency.to_owned(), topic: topic.to_owned() }
}

/// One POST to a push service: the endpoint, the headers in the order they are sent, and the ciphertext.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushRequest {
    pub endpoint: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

/// The push service's answer as a status, or why there was none. Redirects are refused (an error, not a status).
pub type PushOutcome = Result<u16, String>;
pub type PushFuture<'a> = Pin<Box<dyn Future<Output = PushOutcome> + Send + 'a>>;

/// The HTTP client the sender posts through (the `webPushFetch` seam): the real one is [`ReqwestClient`], a test or the twin
/// host installs one that records.
pub trait PushClient: Send + Sync {
    fn post(&self, request: PushRequest) -> PushFuture<'_>;
}

/// The push services over https, redirects refused.
pub struct ReqwestClient(reqwest::Client);

impl ReqwestClient {
    pub fn new() -> Result<Self, String> {
        reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map(Self).map_err(|error| error.to_string())
    }
}

impl PushClient for ReqwestClient {
    fn post(&self, request: PushRequest) -> PushFuture<'_> {
        Box::pin(async move {
            let mut call = self.0.post(&request.endpoint);
            for (name, value) in &request.headers {
                call = call.header(*name, value);
            }
            let response = call.body(request.body).send().await.map_err(|_| "fetch failed".to_owned())?;
            let status = response.status();
            // `redirect: 'error'`: a redirect is a failed fetch.
            if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Err("fetch failed".to_owned());
            }
            Ok(status.as_u16())
        })
    }
}

/// What to send: a validated endpoint, the ciphertext and its options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendRequest {
    pub endpoint: String,
    pub body: Vec<u8>,
    pub options: Options,
}

/// The push service's verdict. `status` is 0 when there was none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendResult {
    pub ok: bool,
    pub status: u16,
    /// 404 or 410: the push service retired the subscription.
    pub expired: bool,
    pub error: Option<String>,
}

impl SendResult {
    fn failed(error: &str) -> Self {
        Self { ok: false, status: 0, expired: false, error: Some(error.to_owned()) }
    }
}

/// Posts messages signed with the relay's identity.
pub struct Sender {
    keys: Arc<VapidKeys>,
    client: Arc<dyn PushClient>,
    subject: String,
}

impl Sender {
    pub fn new(keys: Arc<VapidKeys>, client: Arc<dyn PushClient>) -> Self {
        Self { keys, client, subject: VAPID_SUBJECT.to_owned() }
    }

    /// Posts one already-encrypted message. Never fails: the result says what happened.
    pub async fn send(&self, request: SendRequest) -> SendResult {
        let SendRequest { endpoint, body, options } = request;
        // Again here, not only at registration: whatever reached the registry (an older file, a looser earlier rule) is never
        // posted to.
        if valid_endpoint(&endpoint).as_deref() != Some(endpoint.as_str()) {
            return SendResult::failed("endpoint-not-allowed");
        }
        let authorization = match vapid_authorization(&endpoint, &self.keys, &self.subject, now_ms()) {
            Ok(authorization) => authorization,
            Err(error) => return SendResult::failed(&error),
        };
        let mut headers = vec![
            ("Authorization", authorization),
            ("Content-Encoding", "aes128gcm".to_owned()),
            ("Content-Type", "application/octet-stream".to_owned()),
            ("TTL", options.ttl.to_string()),
            ("Urgency", options.urgency),
        ];
        if !options.topic.is_empty() {
            headers.push(("Topic", options.topic));
        }
        match mixdog_rt::time::timeout(SEND_TIMEOUT, self.client.post(PushRequest { endpoint, headers, body })).await {
            Err(_) => SendResult::failed("This operation was aborted"),
            Ok(Err(error)) => SendResult::failed(&error),
            Ok(Ok(status)) => {
                let expired = status == 404 || status == 410;
                SendResult { ok: (200..300).contains(&status), status, expired, error: None }
            }
        }
    }
}
