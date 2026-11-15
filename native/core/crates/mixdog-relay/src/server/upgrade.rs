//! `handleUpgrade` of `server.mjs`: `/desktop` and `/hookleg` (Basic `deviceId:secret`, authenticated by [`Upgrades::authenticate_leg`]),
//! `/ws` (the phone decision of [`crate::legs::phone`]) and any other path, whose raw socket is destroyed.
//!
//! A refusal before the handshake is the raw `HTTP/1.1 <status> <reason>\r\nConnection: close\r\n\r\n` and a closed connection. A throw
//! anywhere in an upgrade is `[relay] websocket upgrade failed: <message>` and a destroyed socket ([`super::start`] guards the task).

use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use tokio::io::AsyncWriteExt;

use crate::http1::util::{client_ip, request_url};
use crate::http1::{HeaderValue, Headers, PrefixedIo, UpgradeRequest, refusal_bytes};
use crate::hook::HookHub;
use crate::legs::desktop::run_desktop_leg;
use crate::legs::hub::Hub;
use crate::legs::phone::{PhoneLegs, PhoneRequest};
use crate::rate_limit::RateLimiter;
use crate::store::{leg_credentials_usable, read_device_credentials};
use crate::ws::{HandshakeRequest, Transport, WebSocketServer};

/// `REGISTER_RATE_LIMIT` and `REGISTER_RATE_WINDOW_MS`: new device ids one address may mint per window.
pub(super) const REGISTER_RATE_LIMIT: usize = 5;
pub(super) const REGISTER_RATE_WINDOW_MS: i64 = 10 * 60_000;

/// An upgraded connection's decrypted stream is a transport as it is: its read side starts with the bytes the parser read past the head.
impl Transport for PrefixedIo {}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What the upgrade code needs of the relay.
pub(super) struct Upgrades {
    pub hub: Arc<Hub>,
    pub hooks: Arc<HookHub>,
    pub sockets: Arc<WebSocketServer>,
    pub phone: Arc<PhoneLegs>,
    /// `registerLimiter`: only this code charges it.
    pub register_limiter: Mutex<RateLimiter>,
    /// `unauthorizedLimiter`: the relay's one, shared with the routes.
    pub unauthorized: Arc<Mutex<RateLimiter>>,
}

/// What the head of an upgrade says, kept while its stream is handed on.
struct Head {
    headers: Headers,
    remote_address: Option<String>,
    encrypted: bool,
    handshake: HandshakeRequest,
}

/// The request as the WebSocket handshake reads it: its headers as `req.headers` holds them.
fn handshake_request(method: &str, headers: &Headers) -> HandshakeRequest {
    let mut pairs = Vec::new();
    for (name, value) in headers.iter() {
        match value {
            HeaderValue::One(value) => pairs.push((name.to_owned(), value.clone())),
            HeaderValue::Many(values) => pairs.extend(values.iter().map(|value| (name.to_owned(), value.clone()))),
        }
    }
    HandshakeRequest { method: method.to_owned(), headers: pairs }
}

fn split(upgrade: UpgradeRequest) -> (Head, PrefixedIo) {
    let head = Head {
        headers: upgrade.headers.clone(),
        remote_address: upgrade.remote_address.clone(),
        encrypted: upgrade.encrypted,
        handshake: handshake_request(&upgrade.method, &upgrade.headers),
    };
    (head, upgrade.into_stream())
}

/// `rejectLeg`: the refusal of a leg that could not authenticate.
async fn reject(stream: &mut PrefixedIo, status: u16) {
    let reason = if status == 429 { "Too Many Requests" } else { "Unauthorized" };
    // The peer may be gone already: it is being refused.
    let _ = stream.write_all(&refusal_bytes(status, reason)).await;
    let _ = stream.shutdown().await;
}

impl Upgrades {
    /// Serves one upgrade to the end of its connection.
    pub(super) async fn serve(&self, upgrade: UpgradeRequest) {
        let Some(url) = request_url(&upgrade.url) else { return };
        match url.path() {
            "/desktop" => {
                let (head, mut stream) = split(upgrade);
                let Some(device_id) = self.authenticated(&head, &mut stream).await else { return };
                if let Ok((socket, events)) = self.sockets.handle_upgrade(&head.handshake, stream, Bytes::new()).await {
                    run_desktop_leg(Arc::clone(&self.hub), device_id, socket, events).await;
                }
            }
            "/ws" => {
                let (head, stream) = split(upgrade);
                let request = PhoneRequest {
                    url: &url,
                    headers: &head.headers,
                    handshake: &head.handshake,
                    encrypted: head.encrypted,
                    remote_address: head.remote_address.as_deref(),
                };
                self.phone.serve_upgrade(&request, stream, Bytes::new()).await;
            }
            // Channel-worker webhook tunnel: the same trust-on-first-use device model as the desktop leg (the worker mints its own id and
            // secret pair).
            "/hookleg" => {
                let (head, mut stream) = split(upgrade);
                let Some(device_id) = self.authenticated(&head, &mut stream).await else { return };
                if let Ok((socket, events)) = self.sockets.handle_upgrade(&head.handshake, stream, Bytes::new()).await {
                    self.hooks.run_leg(&device_id, socket, events).await;
                }
            }
            // Any other path: the dropped stream is the destroyed socket.
            _ => {}
        }
    }

    /// `authenticatedLegDevice`: the device id a desktop or hook leg authenticated as, or `None` once the upgrade has been refused.
    async fn authenticated(&self, head: &Head, stream: &mut PrefixedIo) -> Option<String> {
        match self.authenticate_leg(&head.headers, head.remote_address.as_deref()).await {
            Ok(device_id) => Some(device_id),
            Err(status) => {
                reject(stream, status).await;
                None
            }
        }
    }

    /// `authenticateLeg`. Trust-on-first-use keeps setup zero-config, but only a bounded number of new ids may be minted per source; a
    /// known device dialling again is free. A failed attempt is charged to the caller either way, otherwise a known device id would be a
    /// free oracle for guessing its secret at network speed. `Err` is the status to refuse with.
    pub(super) async fn authenticate_leg(&self, headers: &Headers, remote_address: Option<&str>) -> Result<String, u16> {
        let credentials = read_device_credentials(headers.get("authorization"));
        let (device_id, secret) = (credentials.device_id, credentials.secret);
        if !leg_credentials_usable(&device_id, &secret) {
            return Err(401);
        }
        let ip = client_ip(remote_address);
        let store = self.hub.store();
        if !store.is_known(&device_id) && !lock(&self.register_limiter).allow(ip) {
            return Err(429);
        }
        if store.authenticate(&device_id, &secret).await {
            return Ok(device_id);
        }
        if lock(&self.unauthorized).allow(&format!("auth:{ip}")) { Err(401) } else { Err(429) }
    }
}
