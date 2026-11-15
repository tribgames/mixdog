//! The phone legs' sockets code: what `/ws` answers (`upgradePhoneLeg`, `closeOfflinePhone`, `closeAnswered`, `closeUnpairedPhone` of
//! `server.mjs`, `phoneClientCapacityAvailable` and `browserSocketOriginAllowed` of `lib/relay-http.mjs`) and the socket loop of one
//! attached phone (`runClientLeg` of `lib/relay-legs.mjs`). The routing itself, the uplink pause, the oversize answers, the local
//! `{"pong":1}`, the handshake turns and the `[relay] phone leg closed` line are the hub's ([`super::hub::PhoneHandle`]); this file
//! decides who gets a socket and what that socket is told, and feeds the hub the events of the socket.
//!
//! [`PhoneLegs::decide`] is the whole decision, in Node's order and with Node's side effects (the limiters charged, the log lines, the
//! slot of a PC-offline answer, `store.touchClient`); [`PhoneLegs::serve_upgrade`] carries it out on a transport, to the end of the
//! connection. The caller runs it in a task of its own, one per upgrade.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::AsyncWriteExt;
use url::Url;

use super::hub::{Hub, IngressInstall, Liveness, PhoneOptions, SweepLeg};
use super::ingress::IngressLeg;
use crate::close_codes::{DESKTOP_OFFLINE, DESKTOP_OFFLINE_REASON, PAIRING_RESCAN_REQUIRED, PAIRING_RESCAN_REQUIRED_REASON};
use crate::http1::conn::panic_message;
use crate::http1::{Headers, refusal_bytes};
use crate::http1::util::{browser_socket_origin_allowed, client_ip};
use crate::logline;
use crate::rate_limit::RateLimiter;
use crate::store::ProfileInput;
use crate::ws::{HandshakeRequest, Transport, WebSocket, WebSocketServer, WsEvent, WsEvents};

/// `MAX_PHONE_CONNECTIONS_PER_MINUTE`: the upgrades one device's phones may complete per window, the PC-offline answer included.
pub const MAX_PHONE_CONNECTIONS_PER_MINUTE: usize = 120;
/// `PHONE_CONNECT_RATE_WINDOW_MS`.
pub const PHONE_CONNECT_RATE_WINDOW_MS: i64 = 60_000;
/// `MAX_PHONE_CLIENTS_PER_DEVICE`: the live phone legs of a device, and separately the PC-offline answers still outstanding for it.
pub const MAX_PHONE_CLIENTS_PER_DEVICE: usize = 32;
/// `ANSWERED_CLOSE_GRACE_MS`: how long a socket answered only with a close code waits for the peer's reply before it is cut.
pub const ANSWERED_CLOSE_GRACE: Duration = Duration::from_secs(5);

/// `phoneClientCapacityAvailable`.
pub fn phone_client_capacity_available(count: usize) -> bool {
    count < MAX_PHONE_CLIENTS_PER_DEVICE
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The numbers of the phone legs; the defaults are the relay's, a test shortens them.
#[derive(Debug, Clone, Copy)]
pub struct PhoneLimits {
    pub connects_per_window: usize,
    pub connect_window_ms: i64,
    pub answered_close_grace: Duration,
}

impl Default for PhoneLimits {
    fn default() -> Self {
        Self {
            connects_per_window: MAX_PHONE_CONNECTIONS_PER_MINUTE,
            connect_window_ms: PHONE_CONNECT_RATE_WINDOW_MS,
            answered_close_grace: ANSWERED_CLOSE_GRACE,
        }
    }
}

/// What the `/ws` decision reads of an upgrade request.
pub struct PhoneRequest<'a> {
    /// The request line as a URL (`requestUrl`).
    pub url: &'a Url,
    pub headers: &'a Headers,
    /// The request as the WebSocket handshake reads it.
    pub handshake: &'a HandshakeRequest,
    /// The connection is TLS (`request.socket.encrypted`).
    pub encrypted: bool,
    /// `request.socket.remoteAddress`.
    pub remote_address: Option<&'a str>,
}

/// One PC-offline answer still outstanding for a device (`relay.offlineClosing`): held until the connection ends, whatever ends it.
pub struct OfflineSlot {
    table: Arc<Mutex<HashMap<String, usize>>>,
    device_id: String,
}

impl Drop for OfflineSlot {
    fn drop(&mut self) {
        let mut table = lock(&self.table);
        let left = table.get(&self.device_id).copied().unwrap_or(1).saturating_sub(1);
        if left > 0 {
            table.insert(self.device_id.clone(), left);
        } else {
            table.remove(&self.device_id);
        }
    }
}

/// What the relay does with one `/ws` upgrade.
pub enum Decision {
    /// A raw HTTP refusal (`rejectUpgrade`): the status line, then the connection is destroyed.
    Refuse { status: u16, reason: &'static str },
    /// The handshake completes and the socket is closed with this code at once (`closeAnswered`). The slot, when there is one, is held
    /// until the connection ends.
    Answer { code: u16, reason: &'static str, slot: Option<OfflineSlot> },
    /// A paired phone whose PC is connected: the handshake completes and the socket becomes a phone leg of the device.
    Attach { device_id: String, browser_client_id: String },
}

/// The relay's phone side: the limiters and the table of outstanding PC-offline answers, over the process's hub and socket server.
pub struct PhoneLegs {
    hub: Arc<Hub>,
    sockets: Arc<WebSocketServer>,
    connect_limiter: Mutex<RateLimiter>,
    unauthorized: Arc<Mutex<RateLimiter>>,
    offline_closing: Arc<Mutex<HashMap<String, usize>>>,
    limits: PhoneLimits,
}

impl PhoneLegs {
    /// `unauthorized` is the relay's one unauthorized-caller limiter (`relay.unauthorizedLimiter`), shared with the HTTP routes and the
    /// leg authentication.
    pub fn new(hub: Arc<Hub>, sockets: Arc<WebSocketServer>, unauthorized: Arc<Mutex<RateLimiter>>, limits: PhoneLimits) -> Arc<Self> {
        Arc::new(Self {
            hub,
            sockets,
            connect_limiter: Mutex::new(RateLimiter::new(limits.connects_per_window, limits.connect_window_ms)),
            unauthorized,
            offline_closing: Arc::new(Mutex::new(HashMap::new())),
            limits,
        })
    }

    /// `upgradePhoneLeg`, up to the point it hands the socket to a leg.
    pub fn decide(&self, request: &PhoneRequest<'_>) -> Decision {
        if !browser_socket_origin_allowed(request.headers, request.encrypted) {
            return Decision::Refuse { status: 403, reason: "Forbidden" };
        }
        let token = request.url.query_pairs().find(|(key, _)| key == "token").map(|(_, value)| value.into_owned()).unwrap_or_default();
        let access = self.hub.store().client_access_for_token(&token);
        let Some((device_id, client_id)) = access.and_then(|access| {
            let client_id = access.client_id.filter(|id| !id.is_empty())?;
            Some((access.device_id, client_id))
        }) else {
            return self.unpaired(request);
        };
        let refuse = |status: u16, reason: &'static str, cause: &str| {
            logline::emit(&logline::phone_upgrade_refused(status, cause, &device_id));
            Decision::Refuse { status, reason }
        };
        // Every upgrade this relay completes is charged, the "PC offline" answer included: it costs a handshake and a socket like any
        // other.
        if !lock(&self.connect_limiter).allow(&device_id) {
            return refuse(429, "Too Many Requests", "rate-limit");
        }
        let info = self.hub.desktop_info(&device_id);
        if !info.as_ref().is_some_and(|info| info.open) {
            // Desktop offline is transient, and the phone has to be able to SAY so: a refused upgrade reaches a browser as a bare 1006
            // that names nobody. The handshake completes and closes with the relay's own "PC offline" code, which is not a pairing
            // failure: the reconnect loop keeps running and the stored pairing is untouched.
            return self.offline(&device_id, refuse);
        }
        if !phone_client_capacity_available(info.map_or(0, |info| info.clients)) {
            return refuse(429, "Too Many Requests", "client-capacity");
        }
        self.hub.store().touch_client(&device_id, &client_id, &ProfileInput::default());
        Decision::Attach { device_id, browser_client_id: client_id }
    }

    /// `closeOfflinePhone`: "PC offline" answers are bounded per device like live phone legs.
    fn offline(&self, device_id: &str, refuse: impl FnOnce(u16, &'static str, &str) -> Decision) -> Decision {
        let mut closing = lock(&self.offline_closing);
        let outstanding = closing.get(device_id).copied().unwrap_or(0);
        if !phone_client_capacity_available(outstanding) {
            drop(closing);
            return refuse(429, "Too Many Requests", "offline-capacity");
        }
        logline::emit(&logline::phone_upgrade_refused_desktop_offline(device_id));
        closing.insert(device_id.to_owned(), outstanding + 1);
        drop(closing);
        let slot = OfflineSlot { table: Arc::clone(&self.offline_closing), device_id: device_id.to_owned() };
        Decision::Answer { code: DESKTOP_OFFLINE, reason: DESKTOP_OFFLINE_REASON, slot: Some(slot) }
    }

    /// `closeUnpairedPhone`: a missing, stale or legacy token is not retryable; the handshake finishes and closes 4005 so the phone
    /// drops its stored pairing and shows the scanner instead of retrying.
    fn unpaired(&self, request: &PhoneRequest<'_>) -> Decision {
        if !lock(&self.unauthorized).allow(client_ip(request.remote_address)) {
            return Decision::Refuse { status: 429, reason: "Too Many Requests" };
        }
        Decision::Answer { code: PAIRING_RESCAN_REQUIRED, reason: PAIRING_RESCAN_REQUIRED_REASON, slot: None }
    }

    /// Decide an upgrade and carry it out on its transport, until the connection ends. `head` is what the HTTP layer read past the
    /// request head.
    pub async fn serve_upgrade<S: Transport>(self: &Arc<Self>, request: &PhoneRequest<'_>, mut io: S, head: Bytes) {
        match self.decide(request) {
            Decision::Refuse { status, reason } => {
                // The peer may be gone already: it is being refused.
                let _ = io.write_all(&refusal_bytes(status, reason)).await;
                let _ = io.shutdown().await;
            }
            Decision::Answer { code, reason, slot } => {
                if let Ok((socket, events)) = self.sockets.handle_upgrade(request.handshake, io, head).await {
                    self.answer_closed(socket, events, code, reason).await;
                }
                drop(slot);
            }
            Decision::Attach { device_id, browser_client_id } => {
                if let Ok((socket, events)) = self.sockets.handle_upgrade(request.handshake, io, head).await {
                    self.run_phone_leg(device_id, browser_client_id, socket, events).await;
                }
            }
        }
    }

    /// `closeAnswered`: close a socket the relay upgraded only to answer it with a close code. The peer can still send anything while
    /// the close waits for its reply: a socket that misbehaves is cut there and then, and one that never replies is cut after the
    /// grace. The socket is listed for the heartbeat sweep like every upgraded socket.
    pub async fn answer_closed(&self, socket: WebSocket, mut events: WsEvents, code: u16, reason: &str) {
        let leg = self.hub.register_leg(SweepLeg { socket: Arc::new(socket.clone()), liveness: Liveness::new(), ingress: None });
        if socket.close(code, reason).is_err() {
            socket.terminate();
        }
        let grace = mixdog_rt::time::sleep_unrefed(self.limits.answered_close_grace);
        tokio::pin!(grace);
        let mut cut = false;
        loop {
            tokio::select! {
                event = events.next() => match event {
                    Some(WsEvent::Error(_)) => socket.terminate(),
                    Some(WsEvent::Close { .. }) | None => break,
                    Some(_) => {}
                },
                () = &mut grace, if !cut => {
                    cut = true;
                    socket.terminate();
                }
            }
        }
        self.hub.unregister_leg(leg);
    }

    /// `runClientLeg` over a real socket: meter its ingress, attach it to its device's desktop and drive it from its events until it
    /// closes. The first event is taken only after the ingress tap is installed, so the tap sees every byte of the connection. A
    /// desktop entry that went away between the decision and here is what a PC that is offline is: the phone is answered 4002.
    pub async fn run_phone_leg(&self, device_id: String, browser_client_id: String, socket: WebSocket, mut events: WsEvents) {
        let install: IngressInstall = {
            let (pool, limits, tapped) = (self.hub.ingress_pool().clone(), self.hub.ingress_limits(), socket.clone());
            Box::new(move |kind| IngressLeg::install(&pool, &tapped, kind, limits))
        };
        let options = PhoneOptions {
            browser_client_id: Some(browser_client_id),
            inflight_ceiling: self.hub.config().max_inflight_bytes,
            ingress: Some(install),
        };
        let Ok(handle) = self.hub.attach_phone(&device_id, Arc::new(socket.clone()), options) else {
            self.answer_closed(socket, events, DESKTOP_OFFLINE, DESKTOP_OFFLINE_REASON).await;
            return;
        };
        let (mut code, mut reason) = (1006, Bytes::new());
        while let Some(event) = events.next().await {
            match event {
                WsEvent::Message { data, is_binary } => {
                    // `guarded('phone frame', ...)`: one bad frame cannot take the leg's reader down.
                    if let Err(payload) = std::panic::catch_unwind(AssertUnwindSafe(|| handle.frame(data, is_binary))) {
                        logline::emit(&logline::label_failed("phone frame", &panic_message(payload.as_ref())));
                    }
                }
                WsEvent::Pong(_) => handle.pong(),
                // A ping is answered by the socket itself; an error is surfaced as the close that follows it.
                WsEvent::Ping(_) | WsEvent::Error(_) => {}
                WsEvent::Close { code: closed, reason: why } => {
                    (code, reason) = (closed, why);
                    break;
                }
            }
        }
        handle.closed(code, &reason);
    }
}
