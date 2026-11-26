//! The desktop leg (`runDesktopLeg` and `handleDesktopFrame` of `lib/relay-legs.mjs`, `attachDesktop` of `server.mjs`): what the relay
//! publishes to a desktop when it connects, and what it does with each frame the desktop sends.
//!
//! The desktop is the one leg every phone of a device shares, so one frame it sends concerns every phone or any: it routes a frame to
//! one phone (`frame`, or a binary routing envelope), fans one out (`broadcast`), refuses one (`close-client`), asks about the
//! paired browsers (`list-clients`, `revoke-client`), revokes itself (`revoke-device`), and declares what it can receive
//! (`desktop-lanes`). Every other type is handed to the area that registered it ([`super::dispatch`]).

use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};

use bytes::Bytes;
use mixdog_rt::TaskClass;
use mixdog_rt::time::Instant;
use serde_json::{Value, json};

use super::dispatch::{CapabilityOffer, HandlerFuture, Later, LegCall};
use super::envelope;
use super::hub::{
    Conn, Entry, Hub, HubState, IngressInstall, Liveness, MediaPending, SocketRef, SweepLeg, SweepTarget, announce_phone, deliver_to_phone, send_json,
    signal_desktop_gone,
};
use super::ingress::{IngressLeg, LegKind};
use super::policy::{self, LegCharge, Outbound, Oversize, Pressure, UplinkLeg, check_oversize, send_to_phone};
use super::watchdog::HandshakeTiming;
use crate::close_codes::{
    DESKTOP_REJECTED_CLIENT, DESKTOP_REJECTED_CLIENT_REASON, DESKTOP_REJECTED_CLIENT_REASON_MAX, DEVICE_REVOKED_REASON, PAIRING_REVOKED_REASON, REVOKED,
    SUPERSEDED, SUPERSEDED_REASON,
};
use crate::pairing::codes::clean_name;
use crate::ws::{FlushCallback, WebSocket, WsEvent, WsEvents};
use crate::{js, logline};

/// The frame types the legs code answers itself; no other area may register them.
pub const BUILT_IN_TYPES: [&str; 10] = [
    "revoke-device",
    "set-client-token",
    "list-clients",
    "revoke-client",
    "desktop-lanes",
    "desktop-version",
    "desktop-name",
    "frame",
    "close-client",
    "broadcast",
];

/// The shortest pairing token the desktop may announce.
const MIN_CLIENT_TOKEN_UNITS: usize = 16;

/// `String(value || fallback)`: a falsy JavaScript value (absent, null, false, 0, NaN, the empty string) is the fallback.
fn truthy_string(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => fallback.to_owned(),
        Some(Value::String(text)) if text.is_empty() => fallback.to_owned(),
        Some(Value::Number(number)) if number.as_f64().is_some_and(|n| n == 0.0 || n.is_nan()) => fallback.to_owned(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

/// A string sent to a phone as the bytes `Buffer.from(string)` gives: a lone surrogate becomes U+FFFD, as `ws`'s send of a JavaScript
/// string does.
fn node_text(text: &str) -> String {
    String::from_utf8(js::node_utf8(text)).unwrap_or_default()
}

/// What a panic carried, for the log line of a frame that failed.
fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_owned();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "panic".to_owned()
}

/// A future that reports a panic inside it instead of unwinding through the leg's reader.
struct Guarded<'a>(Pin<Box<dyn Future<Output = ()> + Send + 'a>>);

impl Future for Guarded<'_> {
    type Output = Result<(), String>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match std::panic::catch_unwind(AssertUnwindSafe(|| self.0.as_mut().poll(cx))) {
            Ok(Poll::Ready(())) => Poll::Ready(Ok(())),
            Ok(Poll::Pending) => Poll::Pending,
            Err(payload) => Poll::Ready(Err(panic_message(payload.as_ref()))),
        }
    }
}

/// `guarded('desktop frame', ...)`: one bad frame cannot take the process down.
fn report_failed_frame(message: &str) {
    logline::emit(&logline::label_failed("desktop frame", message));
}

/// `publishCapabilities`: tell the leg what THIS connection enforces, and again whenever a declaration moves it. Both come from the
/// connection's own state, so the numbers the desktop reads are the numbers its phones are held to, and a leg that changes nothing is
/// answered with nothing.
fn publish_capabilities(conn: &mut Conn, max_frame_bytes: usize, offer: &CapabilityOffer) {
    let frame = policy::relay_capabilities(&conn.uplink, max_frame_bytes, &offer.native_push_platforms, offer.web_push, offer.ice);
    let encoded = js::wire(&frame);
    if encoded == conn.uplink.published {
        return;
    }
    conn.uplink.published.clone_from(&encoded);
    if conn.socket.is_open() {
        conn.socket.send_text(Bytes::from(encoded), None);
    }
}

/// Puts `conn` in the entry of `device_id`, creating the entry when there is none; a redial returns whether it superseded an
/// open desktop leg and any media the old connection had in flight.
fn seat_conn(state: &mut HubState, device_id: &str, conn: Conn, timing: HandshakeTiming) -> (bool, Vec<Box<dyn MediaPending>>) {
    let generation = conn.generation;
    match state.desktops.get_mut(device_id) {
        Some(entry) => {
            if let Some(timer) = entry.offline_timer.take() {
                timer.abort();
            }
            let superseded = entry.conn.as_ref().is_some_and(|old| old.socket.is_open());
            if let Some(old) = &entry.conn {
                old.socket.close(SUPERSEDED, SUPERSEDED_REASON.as_bytes());
            }
            let superseded_media = entry.media.take_all();
            // A desktop/VPS redial is a transport event, not a browser-session event: phone sockets stay attached and are
            // re-announced to the new leg.
            entry.generation = generation;
            entry.conn = Some(conn);
            entry.media_lane = false;
            (superseded, superseded_media)
        }
        None => {
            state.desktops.insert(device_id.to_owned(), Entry::new(generation, Some(conn), Vec::new(), timing, None));
            (false, Vec::new())
        }
    }
}

impl Hub {
    /// `attachDesktop` and the start of `runDesktopLeg`: a desktop leg connected as `device_id`. A redial reuses the previous entry:
    /// its phones stay attached, the old socket is closed 4000 `superseded`, its pending media is failed and the media lane reset. The
    /// new connection starts from the floor of its own declaration; it is told what this relay publishes, then what the registered
    /// areas send on connect, and then every phone still attached is announced to it (a fresh challenge re-arms each phone's timer on
    /// the socket it already has).
    pub fn attach_desktop(self: &Arc<Self>, device_id: &str, socket: SocketRef, ingress: Option<IngressInstall>) -> DesktopHandle {
        let ingress = ingress.map(|install| install(LegKind::Desktop));
        let liveness = Liveness::new();
        let leg_id = self.register_leg(SweepLeg {
            socket: Arc::clone(&socket),
            liveness: Arc::clone(&liveness),
            ingress: ingress.clone(),
            target: SweepTarget::Desktop { device_id: device_id.to_owned() },
        });
        let offer = self.dispatch().capabilities();
        let connect_frames = self.dispatch().connect_frames(device_id);
        let charge = LegCharge::new(Arc::clone(self.meter()));
        let max_frame_bytes = self.config().max_frame_bytes;
        let timing = self.config().handshake;
        let (generation, superseded, phones, superseded_media) = {
            let mut guard = self.lock();
            let state: &mut HubState = &mut guard;
            state.next_generation += 1;
            let generation = state.next_generation;
            let conn = Conn {
                generation,
                socket: Arc::clone(&socket),
                charge: Arc::clone(&charge),
                uplink: UplinkLeg::new(self.config().uplink_capacity_ceiling),
                heard: None,
            };
            let (superseded, superseded_media) = seat_conn(state, device_id, conn, timing);
            let mut phones = 0;
            if let Some(entry) = state.desktops.get_mut(device_id) {
                entry.handshake = timing;
                let Entry { conn, clients, handshake, .. } = entry;
                phones = clients.len();
                if let Some(conn) = conn.as_mut() {
                    publish_capabilities(conn, max_frame_bytes, &offer);
                    // The browser subscriptions this PC may deliver to, after the capabilities that say how.
                    for frame in &connect_frames {
                        send_json(&*conn.socket, frame);
                    }
                    // Existing browser legs survive a transient desktop redial: replaying client-open makes the replacement desktop build
                    // fresh E2EE channels for those same sockets without waiting for backgrounded tabs to reconnect.
                    for phone in clients.iter_mut() {
                        announce_phone(self, device_id, conn, *handshake, phone);
                    }
                }
            }
            (generation, superseded, phones, superseded_media)
        };
        logline::emit(&logline::desktop_leg_opened(device_id, superseded, phones));
        for pending in superseded_media {
            pending.fail();
        }
        DesktopHandle {
            hub: Arc::clone(self),
            device_id: device_id.to_owned(),
            generation,
            socket,
            charge,
            ingress,
            liveness,
            leg_id,
            opened_at: Instant::now(),
            revoked: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            later: Arc::default(),
        }
    }
}

/// One desktop connection, as its sockets code drives it: the frames and events of the socket go in through these methods.
pub struct DesktopHandle {
    hub: Arc<Hub>,
    device_id: String,
    generation: u64,
    socket: SocketRef,
    charge: Arc<LegCharge>,
    ingress: Option<IngressLeg>,
    liveness: Arc<Liveness>,
    leg_id: u64,
    opened_at: Instant,
    /// The device was revoked on this leg: nothing more it says is acted on.
    revoked: AtomicBool,
    finished: AtomicBool,
    later: Arc<Later>,
}

impl DesktopHandle {
    /// The work the frame handlers deferred behind the frames already read.
    pub fn later(&self) -> &Arc<Later> {
        &self.later
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// The generation of this connection in its hub.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn liveness(&self) -> &Arc<Liveness> {
        &self.liveness
    }

    /// The entry of this device, when this connection is still the live one: a superseded leg goes on draining whatever was already on
    /// the wire, and may answer for itself, but nothing it says belongs to the connection that replaced it. This device's routing, and
    /// its declaration, are the live socket's alone.
    fn live_entry<'a>(&self, state: &'a mut HubState) -> Option<&'a mut Entry> {
        state.desktops.get_mut(&self.device_id).filter(|entry| entry.conn.as_ref().is_some_and(|conn| conn.generation == self.generation))
    }

    /// The socket's pong: anything the desktop leg says proves the shared leg is read and answered.
    pub fn pong(&self) {
        self.liveness.mark();
        let mut guard = self.hub.lock();
        if let Some(entry) = self.live_entry(&mut guard)
            && let Some(conn) = entry.conn.as_mut()
        {
            conn.heard = Some(Instant::now());
        }
    }

    /// `handleDesktopFrame`: one message from the desktop. Bookkeeping first: a message that is not acted on still has to give its
    /// ingress reservation back. Frames of one leg are answered in the order they arrive.
    pub async fn frame(&self, data: Bytes, is_binary: bool) {
        let announced = self.ingress.as_ref().is_some_and(IngressLeg::note_delivery);
        let live = {
            let mut guard = self.hub.lock();
            match self.live_entry(&mut guard) {
                Some(entry) => {
                    if let Some(conn) = entry.conn.as_mut() {
                        conn.heard = Some(Instant::now());
                    }
                    true
                }
                None => false,
            }
        };
        if self.revoked.load(Ordering::SeqCst) || !live {
            return;
        }
        self.liveness.mark();
        // Oversize is answered ON this leg and the leg stays open: cutting it here reaches every attached phone as a relay outage over
        // one bad frame. The wire form travels with the refusal: a binary frame is read by the binary decoder that routes it, a text
        // frame by the JSON parser.
        let limit = self.hub.config().max_frame_bytes;
        if let Oversize::Refused { announce } = check_oversize(data.len(), limit, announced) {
            if announce {
                self.socket.send_text(Bytes::from(policy::desktop_oversize_notice(data.len(), limit, &data, is_binary)), None);
            }
            return;
        }
        if is_binary {
            if let Err(payload) = std::panic::catch_unwind(AssertUnwindSafe(|| self.binary_frame(&data))) {
                report_failed_frame(&panic_message(payload.as_ref()));
            }
            return;
        }
        if let Err(message) = Guarded(Box::pin(self.text_frame(&data))).await {
            report_failed_frame(&message);
        }
    }

    /// A routing envelope: one phone's frame. Admission is per phone leg, so a congested phone slows nothing but itself: this desktop
    /// socket is never paused for one consumer.
    fn binary_frame(&self, data: &Bytes) {
        let Some(frame) = envelope::decode_frame(data) else { return };
        let mut guard = self.hub.lock();
        let Some(entry) = self.live_entry(&mut guard) else { return };
        let Some(phone) = entry.clients.iter_mut().find(|phone| phone.id == frame.client_id) else { return };
        phone.watch.note_desktop_turn();
        deliver_to_phone(phone, Outbound::Binary(frame.data), frame.droppable);
    }

    async fn text_frame(&self, data: &Bytes) {
        let Ok(message) = js::parse_bytes(data) else { return };
        let kind = match &message {
            // `message.type` of `null` throws in Node; the guard reports it.
            Value::Null => {
                report_failed_frame("Cannot read properties of null (reading 'type')");
                return;
            }
            Value::Object(map) => map.get("type").and_then(Value::as_str).map(str::to_owned),
            _ => None,
        };
        let Some(kind) = kind else { return };
        match kind.as_str() {
            "revoke-device" => self.revoke_device().await,
            "set-client-token" => self.set_client_token(&message).await,
            "list-clients" => self.list_clients(&message),
            "revoke-client" => self.revoke_client(&message).await,
            "desktop-lanes" => self.declare_lanes(&message),
            "desktop-version" => self.report_version(&message),
            "desktop-name" => self.report_name(&message),
            "frame" => self.forward_frame(&message),
            "close-client" => self.close_client(&message),
            "broadcast" => self.broadcast(&message),
            other => {
                // Media proxy frames (head, body chunks, then end) and every other area's frames: the relay only forwards what it is
                // handed; the owning area decides.
                if let Some(handler) = self.hub.dispatch().handler_for(other) {
                    handler(LegCall {
                        later: Arc::clone(&self.later),
                        hub: Arc::clone(&self.hub),
                        generation: self.generation,
                        device_id: self.device_id.clone(),
                        message,
                    })
                    .await;
                }
            }
        }
    }

    /// `revokeDevice`. A revocation that cannot be persisted is reported as a failure and the leg is kept: closing it as revoked would
    /// tell the user the credential is gone while it still authenticates after a restart.
    async fn revoke_device(&self) {
        if !self.hub.store().revoke(&self.device_id).await {
            send_json(&*self.socket, &json!({ "type": "device-revoked", "ok": false }));
            return;
        }
        self.hub.dispatch().device_revoked(&self.device_id);
        self.revoked.store(true, Ordering::SeqCst);
        let phones = self.phone_sockets();
        for phone in phones {
            phone.close(REVOKED, PAIRING_REVOKED_REASON.as_bytes());
        }
        let socket = Arc::clone(&self.socket);
        let finish: FlushCallback = Box::new(move |_| socket.close(REVOKED, DEVICE_REVOKED_REASON.as_bytes()));
        self.socket.send_text(Bytes::from(js::wire(&json!({ "type": "device-revoked", "ok": true }))), Some(finish));
    }

    fn phone_sockets(&self) -> Vec<SocketRef> {
        let guard = self.hub.lock();
        guard.desktops.get(&self.device_id).map(|entry| entry.clients.iter().map(|phone| Arc::clone(&phone.shared.socket)).collect()).unwrap_or_default()
    }

    async fn set_client_token(&self, message: &Value) {
        let Some(token) = message.get("token").and_then(Value::as_str) else { return };
        if js::js_len(token) >= MIN_CLIENT_TOKEN_UNITS {
            // Persisted before it is honoured; a refused write changes nothing and is already logged.
            let _ = self.hub.store().set_client_token(&self.device_id, token).await;
        }
    }

    fn list_clients(&self, message: &Value) {
        let Some(request_id) = message.get("requestId").and_then(Value::as_str) else { return };
        let online = self.hub.online_browsers(&self.device_id);
        let clients = self.hub.store().list_clients(&self.device_id, &|id| online.contains(id));
        let listed: Vec<Value> = clients
            .into_iter()
            .map(|client| {
                let mut row = serde_json::Map::new();
                row.insert("id".into(), Value::String(client.id));
                row.insert("name".into(), Value::String(client.name));
                row.insert("platform".into(), Value::String(client.platform));
                row.insert("browser".into(), Value::String(client.browser));
                // A time the store does not have is left out, as an `undefined` is by `JSON.stringify`.
                if !client.created_at.is_nan() {
                    row.insert("createdAt".into(), mixdog_js::json_number(client.created_at));
                }
                if !client.last_seen_at.is_nan() {
                    row.insert("lastSeenAt".into(), mixdog_js::json_number(client.last_seen_at));
                }
                row.insert("online".into(), Value::Bool(client.online));
                Value::Object(row)
            })
            .collect();
        send_json(&*self.socket, &json!({ "type": "clients-list", "requestId": request_id, "clients": listed }));
    }

    /// `revokeClient`. Only a credential that is actually gone closes its browser: a failed persist leaves the pairing valid, and
    /// closing it as revoked would tell the user something the store did not do.
    async fn revoke_client(&self, message: &Value) {
        let (Some(request_id), Some(client_id)) = (message.get("requestId").and_then(Value::as_str), message.get("clientId").and_then(Value::as_str)) else {
            return;
        };
        let removed = self.hub.store().revoke_client(&self.device_id, client_id).await;
        if removed {
            self.hub.dispatch().client_revoked(&self.device_id, client_id);
            let doomed: Vec<SocketRef> = {
                let guard = self.hub.lock();
                guard
                    .desktops
                    .get(&self.device_id)
                    .map(|entry| {
                        entry
                            .clients
                            .iter()
                            .filter(|phone| phone.browser_client_id.as_deref() == Some(client_id))
                            .map(|phone| Arc::clone(&phone.shared.socket))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            for phone in doomed {
                phone.close(REVOKED, PAIRING_REVOKED_REASON.as_bytes());
            }
        }
        send_json(&*self.socket, &json!({ "type": "client-revoked", "requestId": request_id, "ok": removed }));
    }

    fn declare_lanes(&self, message: &Value) {
        let offer = self.hub.dispatch().capabilities();
        let max_frame_bytes = self.hub.config().max_frame_bytes;
        let mut guard = self.hub.lock();
        let Some(entry) = self.live_entry(&mut guard) else { return };
        entry.media_lane = message.get("media") == Some(&Value::Bool(true));
        // Pairing v2 (6-digit codes, direct browser connect). Declared per leg like every other lane: an older desktop never says it,
        // so it stays false.
        entry.pair_v2 = message.get("pairV2").and_then(Value::as_f64) == Some(1.0);
        let declared = message.get("maxPayloadBytes").and_then(policy::js_number);
        let text_frames = message.get("textFrames").and_then(Value::as_f64) == Some(1.0);
        if let Some(conn) = entry.conn.as_mut() {
            conn.uplink.declare(declared, text_frames);
            // Answer the declaration on the connection it was made on: the leg now knows which envelope its text will actually travel in,
            // and the ceilings that go with it.
            publish_capabilities(conn, max_frame_bytes, &offer);
        }
    }

    /// The desktop's build, reported once per leg. It only selects which renderer release the relay serves this device's phones; an old
    /// desktop never sends it.
    fn report_version(&self, message: &Value) {
        let _ = self.hub.store().record_desktop_version(&self.device_id, message);
    }

    /// The desktop's own name for itself, shown in the PC switcher of the remote UI. A label only; it is never an identifier.
    fn report_name(&self, message: &Value) {
        let mut guard = self.hub.lock();
        if let Some(entry) = self.live_entry(&mut guard) {
            entry.host_name = Some(clean_name(message.get("name").and_then(Value::as_str)));
        }
    }

    fn forward_frame(&self, message: &Value) {
        let Some(data) = message.get("data").and_then(Value::as_str) else { return };
        let client_id = truthy_string(message.get("clientId"), "");
        let droppable = message.get("droppable") == Some(&Value::Bool(true));
        let text = node_text(data);
        let mut guard = self.hub.lock();
        let Some(entry) = self.live_entry(&mut guard) else { return };
        let Some(phone) = entry.clients.iter_mut().find(|phone| phone.id == client_id) else { return };
        phone.watch.note_desktop_turn();
        deliver_to_phone(phone, Outbound::Text(&text), droppable);
    }

    /// The PC answered this phone with a rejection. Its handshake is over the moment the rejection starts, whether or not the phone
    /// ever acknowledges the close: nothing here may hold the PC to a turn for it.
    fn close_client(&self, message: &Value) {
        let client_id = truthy_string(message.get("clientId"), "");
        let reason = js::js_slice(&truthy_string(message.get("reason"), DESKTOP_REJECTED_CLIENT_REASON), DESKTOP_REJECTED_CLIENT_REASON_MAX);
        let mut guard = self.hub.lock();
        let Some(entry) = self.live_entry(&mut guard) else { return };
        let Some(phone) = entry.clients.iter_mut().find(|phone| phone.id == client_id) else { return };
        phone.closing = true;
        phone.watch.end();
        phone.shared.socket.close(DESKTOP_REJECTED_CLIENT, &js::node_utf8(&reason));
    }

    fn broadcast(&self, message: &Value) {
        let Some(data) = message.get("data").and_then(Value::as_str) else { return };
        let droppable = message.get("critical") != Some(&Value::Bool(true));
        let text = node_text(data);
        let mut guard = self.hub.lock();
        let Some(entry) = self.live_entry(&mut guard) else { return };
        for phone in entry.clients.iter_mut() {
            send_to_phone(phone, Outbound::Text(&text), droppable, Pressure::Defer);
        }
    }

    /// The socket closed (`socket.on('close')`): the leg's accounting goes with it. The close code is logged only and never acted on: whatever this
    /// receiver did with whatever frame, it says nothing this relay can attribute, and the leg state that could have carried a verdict
    /// forward goes away with the socket, so the next connection starts from its own declaration. A live leg's close parks its phones:
    /// they keep answering their own pings, so each is told once the desktop is gone, and a replacement leg within the grace rekeys them
    /// in place; after it they are closed 4002 and the entry goes.
    pub fn closed(&self) {
        self.closed_with(1006, b"");
    }

    pub fn closed_with(&self, code: u16, reason: &[u8]) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        self.charge.release_all();
        if let Some(ingress) = &self.ingress {
            ingress.release();
        }
        self.hub.unregister_leg(self.leg_id);
        let (live, superseded, phones, media) = {
            let mut guard = self.hub.lock();
            let superseded = guard.desktops.get(&self.device_id).is_some_and(|e| e.generation != self.generation);
            match self.live_entry(&mut guard) {
                None => (false, superseded, 0, Vec::new()),
                Some(entry) => {
                    let phones = entry.clients.len();
                    let media = entry.media.take_all();
                    for phone in &entry.clients {
                        signal_desktop_gone(&phone.shared, false);
                    }
                    if let Some(timer) = entry.offline_timer.take() {
                        timer.abort();
                    }
                    entry.offline_timer = Some(self.hub.spawn_offline_timer(&self.device_id, self.generation));
                    (true, false, phones, media)
                }
            }
        };
        let lived_ms = i64::try_from(self.opened_at.elapsed().as_millis()).unwrap_or(i64::MAX);
        logline::emit(&logline::desktop_leg_closed(&self.device_id, code, &js::decode_utf8(reason), lived_ms, phones, superseded));
        if live {
            // A closed live leg's pairing code dies with it; a superseded leg must not clear the code its replacement just requested.
            self.hub.dispatch().leg_closed(&self.device_id);
        }
        for pending in media {
            pending.fail();
        }
    }
}

/// `runDesktopLeg` over a real socket: meter its ingress, attach it, and drive it from its events until it closes. The first event is
/// taken only after the ingress tap is installed, so the tap sees every byte of the connection.
pub async fn run_desktop_leg(hub: Arc<Hub>, device_id: String, ws: WebSocket, mut events: WsEvents) {
    let install: IngressInstall = {
        let (pool, limits, socket) = (hub.ingress_pool().clone(), hub.ingress_limits(), ws.clone());
        Box::new(move |kind| IngressLeg::install(&pool, &socket, kind, limits))
    };
    let handle = hub.attach_desktop(&device_id, Arc::new(ws), Some(install));
    // Work the handlers deferred starts when no frame is ready, as a promise of Node's runs after the frames of the read. Once
    // started it goes on by itself (a task of its own), as a promise goes on with its I/O whatever frames arrive after: a push
    // send is not held back by a busy leg.
    let mut later: Vec<HandlerFuture> = Vec::new();
    handle.later().drive();
    let (mut code, mut reason) = (1006, Bytes::new());
    loop {
        tokio::select! {
            biased;
            event = events.next() => {
                let Some(event) = event else { break };
                match event {
                    WsEvent::Message { data, is_binary } => {
                        handle.frame(data, is_binary).await;
                        later.extend(handle.later().take());
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
            // No frame is ready: what the frames read so far deferred starts now, in the order it was deferred.
            () = std::future::ready(()), if !later.is_empty() => {
                for mut work in later.drain(..) {
                    // Each runs here to its first wait, in order (a promise's synchronous part: an answer that needs no
                    // I/O is written before the next one starts), and the rest of it on a task of its own.
                    if futures::poll!(work.as_mut()).is_pending() {
                        mixdog_rt::spawn("relay-deferred", TaskClass::Work, work);
                    }
                }
            }
        }
    }
    // What was deferred and not started goes on after the leg: the answer is written to a socket that may be gone, as in Node.
    later.extend(handle.later().release());
    for work in later {
        mixdog_rt::spawn("relay-deferred", TaskClass::Work, work);
    }
    handle.closed_with(code, &reason);
}
