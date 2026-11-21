//! Native app push delivery: APNs (HTTP/2, token auth) and FCM (HTTP v1). The relay holds the credentials and carries the opaque
//! `mx` string the desktop encrypted for the phone; it never sees notification content.
//!
//! [`NativePush`] is the credentialed sender. The leg side talks to it only through [`PushSender`], and it reaches Apple and
//! Google only through [`HttpTransport`].

mod apns;
mod bindings;
mod fcm;
pub mod frames;
mod jwt;
mod keys;

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

pub use apns::ApnsSender;
pub use bindings::{
    MAX_MX_CHARS, MAX_NATIVE_BINDINGS_PER_DEVICE, NATIVE_PUSH_REASONS, NATIVE_SENDS_PER_MINUTE, NativePushService, PairedClients, valid_collapse_key,
    valid_native_token,
};
pub use fcm::FcmSender;
pub use jwt::{AccessTokenCache, ProviderTokenCache, apns_provider_token, fcm_assertion};
pub use keys::{ApnsConfig, FcmConfig, parse_ec_p256_pem, parse_rsa_pem, read_apns_config, read_fcm_config};

pub const APNS_PRODUCTION: &str = "https://api.push.apple.com";
pub const APNS_SANDBOX: &str = "https://api.sandbox.push.apple.com";
pub const FCM_ORIGIN: &str = "https://fcm.googleapis.com";

/// Every request of a push has this long: Node's `REQUEST_TIMEOUT_MS`.
pub const REQUEST_TIMEOUT_MS: u64 = 10_000;
/// A notification is not worth delivering an hour after it was sent.
pub const NOTIFICATION_TTL_SECONDS: i64 = 3600;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `Date.now()` of the sender, injectable for tests.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The clock of the process: the replay's `Date.now()`.
pub fn system_clock() -> Clock {
    Arc::new(crate::rate_limit::now_ms)
}

/// The two push services.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Apns,
    Fcm,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Apns => "apns",
            Platform::Fcm => "fcm",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "apns" => Some(Platform::Apns),
            "fcm" => Some(Platform::Fcm),
            _ => None,
        }
    }
}

/// One validated notification to deliver.
#[derive(Debug, Clone, PartialEq)]
pub struct PushMessage {
    pub platform: Platform,
    pub token: String,
    pub mx: String,
    pub reason: String,
    pub collapse_key: String,
    /// The environment the app reported at registration; APNs only. `None` leaves it to `APNS_ENVIRONMENT`.
    pub sandbox: Option<bool>,
}

/// `{ ok, status, invalid?, error? }`: what a send comes to. A send never fails past this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendResult {
    pub ok: bool,
    /// 0 when no response came.
    pub status: u16,
    /// The service says the token is dead.
    pub invalid: bool,
    pub error: Option<String>,
}

impl SendResult {
    pub fn failed(error: &str) -> Self {
        Self { ok: false, status: 0, invalid: false, error: Some(error.to_owned()) }
    }
}

/// What the desktop legs send through: the credentialed [`NativePush`], or a recording fake.
pub trait PushSender: Send + Sync {
    /// The platforms this relay can deliver to, in advertising order (`apns` then `fcm`).
    fn platforms(&self) -> Vec<&'static str>;
    /// Resolves to the outcome; never fails.
    fn send<'a>(&'a self, message: &'a PushMessage) -> BoxFuture<'a, SendResult>;
    /// Drops the pooled connections; a later send reconnects.
    fn close(&self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    /// Lower-case names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// APNs speaks HTTP/2 only; the transport keeps its connection pool for it apart.
    pub http2_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// [`REQUEST_TIMEOUT_MS`] passed without an answer.
    Timeout,
    Failed(String),
}

/// POSTs a request and returns what came back.
pub trait HttpTransport: Send + Sync {
    fn post(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>>;
    /// Drops the HTTP/2 connections it holds (`close()` of the APNs sessions).
    fn close(&self);
}

/// The transport of the relay process: reqwest, one pooled HTTP/2 connection per origin for APNs and the ordinary pool
/// for the OAuth exchange and FCM. A failed request drops the pooled connections, as a session `error` did.
pub struct ReqwestTransport {
    http2: Mutex<reqwest::Client>,
    general: reqwest::Client,
}

fn http2_client() -> reqwest::Client {
    reqwest::Client::builder().http2_prior_knowledge().build().unwrap_or_default()
}

impl ReqwestTransport {
    pub fn new() -> Self {
        Self { http2: Mutex::new(http2_client()), general: reqwest::Client::new() }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for ReqwestTransport {
    fn post(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        Box::pin(async move {
            let client = if request.http2_only { self.http2.lock().unwrap_or_else(PoisonError::into_inner).clone() } else { self.general.clone() };
            let mut builder = client.post(&request.url).timeout(Duration::from_millis(REQUEST_TIMEOUT_MS));
            for (name, value) in &request.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            let http2_only = request.http2_only;
            let outcome = async {
                let response = builder.body(request.body).send().await?;
                let status = response.status().as_u16();
                let body = response.bytes().await?;
                Ok::<_, reqwest::Error>(HttpResponse { status, body: body.to_vec() })
            }
            .await;
            outcome.map_err(|error| {
                if http2_only {
                    self.close();
                }
                if error.is_timeout() { TransportError::Timeout } else { TransportError::Failed(error.to_string()) }
            })
        })
    }

    fn close(&self) {
        *self.http2.lock().unwrap_or_else(PoisonError::into_inner) = http2_client();
    }
}

/// The hosts a sender talks to; tests point them at a recording transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origins {
    pub apns_production: String,
    pub apns_sandbox: String,
    pub fcm: String,
}

impl Default for Origins {
    fn default() -> Self {
        Self { apns_production: APNS_PRODUCTION.to_owned(), apns_sandbox: APNS_SANDBOX.to_owned(), fcm: FCM_ORIGIN.to_owned() }
    }
}

/// The credentialed sender: APNs and FCM, each present only when its credentials are.
pub struct NativePush {
    apns: Option<ApnsSender>,
    fcm: Option<FcmSender>,
}

impl NativePush {
    /// Reads the credentials from the environment. Credentials that do not parse disable that platform instead of
    /// stopping the relay: a push misconfiguration must never take pairing down with it.
    pub fn new(env: &BTreeMap<String, String>, transport: &Arc<dyn HttpTransport>, origins: &Origins, clock: &Clock) -> Self {
        let apns = unless_unusable("APNs", read_apns_config(env)).map(|config| ApnsSender::new(config, Arc::clone(transport), origins, Arc::clone(clock)));
        let fcm =
            unless_unusable("FCM", read_fcm_config(env)).map(|config| FcmSender::new(config, Arc::clone(transport), origins.fcm.clone(), Arc::clone(clock)));
        Self { apns, fcm }
    }

    /// The sender of the relay process: the environment, the real hosts and the system clock.
    pub fn from_environment(env: &BTreeMap<String, String>) -> Self {
        let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new());
        Self::new(env, &transport, &Origins::default(), &system_clock())
    }

    /// The relay offers native push only when a platform can deliver.
    pub fn is_configured(&self) -> bool {
        self.apns.is_some() || self.fcm.is_some()
    }
}

fn unless_unusable<T>(label: &str, read: Result<Option<T>, String>) -> Option<T> {
    match read {
        Ok(config) => config,
        Err(message) => {
            crate::logline::emit(&crate::logline::push_credentials_unusable(label, &message));
            None
        }
    }
}

impl PushSender for NativePush {
    fn platforms(&self) -> Vec<&'static str> {
        let mut platforms = Vec::new();
        if self.apns.is_some() {
            platforms.push(Platform::Apns.as_str());
        }
        if self.fcm.is_some() {
            platforms.push(Platform::Fcm.as_str());
        }
        platforms
    }

    fn send<'a>(&'a self, message: &'a PushMessage) -> BoxFuture<'a, SendResult> {
        Box::pin(async move {
            let outcome = match (message.platform, &self.apns, &self.fcm) {
                (Platform::Apns, Some(sender), _) => sender.send(message).await,
                (Platform::Fcm, _, Some(sender)) => sender.send(message).await,
                _ => return SendResult::failed("platform-unavailable"),
            };
            outcome.unwrap_or_else(|error| SendResult::failed(if error.is_empty() { "send failed" } else { &error }))
        })
    }

    fn close(&self) {
        if let Some(sender) = &self.apns {
            sender.close();
        }
    }
}
