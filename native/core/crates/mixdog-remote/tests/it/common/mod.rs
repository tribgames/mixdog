//! A `RemoteRuntime` on a leg to a local scripted relay, for the tests that drive it through its
//! public surface. Not every test crate uses every helper.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use mixdog_core_api::state::{SectionChange, StatePublisher};
use mixdog_protocol::SectionName;
use mixdog_remote::access::runtime::{LegLink, RemoteEvents, RemoteRuntime, RuntimeConfig};
use mixdog_remote::access::settings::AccessSettings;
use mixdog_remote::bridge::{DialError, Dialer, Upstream};
use mixdog_remote::e2ee::{Challenge, Channel, ClientHandshakeOptions, Sealed, ServerIdentity, Wire, create_client_handshake};
use mixdog_remote::leg::frame::json_frame;
use mixdog_remote::pair_code::{PairCodeEffects, PairCodeView};
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::section::{RemoteSection, RemoteSectionValue};
use mixdog_rt::{CancellationToken, InLane, LaneToken};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

/// Runs `job` on the durability lane and returns its result.
pub fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
    let out = Arc::new(Mutex::new(None));
    let slot = out.clone();
    mixdog_rt::testing::tokens()
        .durability_io
        .submit(&CancellationToken::new(), move |lane| {
            *slot.lock().unwrap() = Some(job(lane));
        })
        .unwrap();
    out.lock().unwrap().take().unwrap()
}

pub struct NoEffects;
impl PairCodeEffects for NoEffects {
    fn send(&mut self, _: Value) -> bool {
        false
    }
    fn publish(&mut self, _: Option<&PairCodeView>) {}
    fn wake_at(&mut self, _: u64) {}
}

pub struct NoDial;
#[async_trait]
impl Dialer for NoDial {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        Err(DialError)
    }
}

pub struct Silent;
impl StatePublisher for Silent {
    fn publish(&self, _: SectionName, _: Option<String>, _: SectionChange) {}
}

pub struct Quiet;
impl RemoteEvents for Quiet {
    fn controller_key_delivered(&self, _: &str) {}
    fn owed_access_changed(&self) {}
    fn status(&self, _: Value) {}
}

/// What the scripted relay does to the leg it holds.
pub enum LegEnd {
    /// The connection is dropped with no close frame (a dead path).
    Drop,
    /// The relay closes the leg with this WebSocket close code.
    Close(u16),
}

/// Frames the relay was sent and no test step has asked for yet.
struct Inbox {
    rx: mpsc::UnboundedReceiver<Value>,
    backlog: Vec<Value>,
}

impl Inbox {
    /// The first frame, kept or still to come, that `wanted` accepts; the others stay for later asks.
    async fn take(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        if let Some(at) = self.backlog.iter().position(&wanted) {
            return self.backlog.remove(at);
        }
        loop {
            // The relay's channel ends when the relay task does, which fails the test at once; no clock.
            let frame = self.rx.recv().await.expect("relay closed");
            if wanted(&frame) {
                return frame;
            }
            self.backlog.push(frame);
        }
    }

    /// Every frame that arrived so far and matches `wanted`, without waiting for more.
    fn arrived(&mut self, wanted: impl Fn(&Value) -> bool) -> Vec<Value> {
        while let Ok(frame) = self.rx.try_recv() {
            self.backlog.push(frame);
        }
        self.backlog.iter().filter(|frame| wanted(frame)).cloned().collect()
    }
}

type SharedInbox = Arc<tokio::sync::Mutex<Inbox>>;

/// A scripted relay: it accepts the desktop's legs one after another, declares the capabilities on
/// each, answers `list-clients` with the rows it was given and `revoke-client` with success,
/// reports every other frame, writes what the test sends, and ends the current leg when told to.
pub struct Relay {
    pub port: u16,
    pub out: mpsc::UnboundedSender<Value>,
    /// Ends the leg the relay holds; the desktop redials and the relay accepts the next one.
    pub end_leg: mpsc::UnboundedSender<LegEnd>,
    /// Refuses the next dials (an HTTP 503 to the upgrade) while set.
    pub refuse_dials: Arc<std::sync::atomic::AtomicBool>,
    /// One entry per dial the desktop made, refused or not, with the instant the relay saw it.
    pub legs: mpsc::UnboundedReceiver<std::time::Instant>,
    inbox: SharedInbox,
}

pub async fn driven_relay(clients: Value) -> Relay {
    driven_relay_with(clients, true).await
}

/// [`driven_relay`] whose answer to `revoke-client` is `revoke_ok` (a relay that fails to unpair a device).
pub async fn driven_relay_with(clients: Value, revoke_ok: bool) -> Relay {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen_tx, seen) = mpsc::unbounded_channel();
    let (out, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let (end_leg, mut end_rx) = mpsc::unbounded_channel::<LegEnd>();
    let (legs_tx, legs) = mpsc::unbounded_channel();
    let refuse_dials = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let refusing = refuse_dials.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            // Decided before the dial is reported: the test re-arms the flag for the next dial as soon as it sees this one.
            let refused = refusing.load(std::sync::atomic::Ordering::SeqCst);
            let _ = legs_tx.send(std::time::Instant::now());
            let upgrade = |_: &Request, response: Response| {
                if refused {
                    return Err(Response::builder().status(503).body(None).unwrap());
                }
                Ok(response)
            };
            // A refused upgrade ends this dial; the desktop backs off and dials again.
            let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, upgrade).await else { continue };
            let caps = json!({ "type": "relay-capabilities", "textFrames": 1, "maxFrameBytes": 1_048_576 });
            ws.send(Message::Text(caps.to_string().into())).await.unwrap();
            loop {
                tokio::select! {
                    message = ws.next() => match message {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                            let answer = match frame["type"].as_str() {
                                Some("list-clients") => Some(json!({ "type": "clients-list", "requestId": frame["requestId"], "clients": clients })),
                                Some("revoke-client") if revoke_ok => Some(json!({ "type": "client-revoked", "requestId": frame["requestId"], "ok": true })),
                                Some("revoke-client") => Some(json!({ "type": "client-revoked", "requestId": frame["requestId"], "ok": false, "error": "The relay could not unpair the device." })),
                                _ => None,
                            };
                            if let Some(answer) = answer {
                                ws.send(Message::Text(answer.to_string().into())).await.unwrap();
                            }
                            if frame["type"] != "list-clients" {
                                let _ = seen_tx.send(frame);
                            }
                        }
                        Some(Ok(_)) => {}
                        // The desktop ended this leg: the next one is accepted.
                        _ => break,
                    },
                    send = out_rx.recv() => match send {
                        Some(frame) => ws.send(Message::Text(frame.to_string().into())).await.unwrap(),
                        None => return,
                    },
                    end = end_rx.recv() => match end {
                        Some(LegEnd::Drop) => break,
                        Some(LegEnd::Close(code)) => {
                            let frame = CloseFrame { code: code.into(), reason: "".into() };
                            ws.close(Some(frame)).await.unwrap();
                            // The close handshake completes before the socket is dropped, as a conforming relay does (`ws` waits for the peer's
                            // close frame): dropping it under the desktop's unread writes resets the connection, which discards the frame.
                            while ws.next().await.is_some_and(|message| message.is_ok()) {}
                            break;
                        }
                        None => return,
                    },
                }
            }
        }
    });
    Relay { port, out, end_leg, refuse_dials, legs, inbox: Arc::new(tokio::sync::Mutex::new(Inbox { rx: seen, backlog: Vec::new() })) }
}

/// What the PC sent a relay client.
pub enum Event {
    /// An application frame, still in the form the relay carries it (sealed once a channel exists).
    Frame(String),
    /// `close-client` with its reason.
    Closed(String),
}

/// A phone the relay announced (`client-open`), with no channel yet.
pub struct Peer {
    id: String,
    out: mpsc::UnboundedSender<Value>,
    inbox: SharedInbox,
}

impl Peer {
    pub fn send_frame(&self, data: &str) {
        self.out.send(json_frame(&self.id, data)).unwrap();
    }

    /// The next thing the PC did to this client.
    pub async fn next(&self) -> Event {
        let id = self.id.clone();
        let frame = self.inbox.lock().await.take(move |f| matches!(f["type"].as_str(), Some("frame" | "close-client")) && f["clientId"] == id.as_str()).await;
        if frame["type"] == "close-client" {
            return Event::Closed(frame["reason"].as_str().unwrap_or_default().to_owned());
        }
        Event::Frame(frame["data"].as_str().unwrap().to_owned())
    }

    /// Every frame for this client that reached the relay so far (none when the PC ignored it).
    pub async fn arrived(&self) -> usize {
        let id = self.id.clone();
        self.inbox.lock().await.arrived(move |f| matches!(f["type"].as_str(), Some("frame" | "close-client")) && f["clientId"] == id.as_str()).len()
    }

    /// The relay's challenge for this client.
    pub async fn challenge(&self) -> Challenge {
        let Event::Frame(text) = self.next().await else { panic!("the PC closed the client instead of challenging it") };
        Challenge::parse(serde_json::from_str(&text).unwrap()).unwrap()
    }
}

/// A paired phone on an established E2EE channel through the scripted relay.
pub struct Phone {
    peer: Peer,
    channel: Channel,
}

impl Relay {
    /// The relay announces client `id` of paired credential `credential`.
    pub fn open_peer(&self, id: &str, credential: &str) -> Peer {
        self.out.send(json!({ "type": "client-open", "clientId": id, "browserClientId": credential })).unwrap();
        Peer { id: id.to_owned(), out: self.out.clone(), inbox: self.inbox.clone() }
    }

    /// The phone `id` of paired credential `credential` opens: challenge, hello, ready.
    pub async fn pair_phone(&self, identity: &ServerIdentity, id: &str, credential: &str) -> Phone {
        let peer = self.open_peer(id, credential);
        let challenge = peer.challenge().await;
        let (hello, channel) = create_client_handshake(&identity.pairing(), &challenge, ClientHandshakeOptions::default()).unwrap();
        peer.send_frame(&hello.to_string());
        let mut phone = Phone { peer, channel };
        let ready: Value = serde_json::from_str(&phone.recv().await).unwrap();
        assert_eq!(ready["type"], "e2ee-ready");
        phone
    }

    /// The first frame the relay was sent that `wanted` accepts (`revoke-client`, say).
    pub async fn frame(&self, wanted: impl Fn(&Value) -> bool) -> Value {
        self.inbox.lock().await.take(wanted).await
    }
}

impl Phone {
    /// One application text frame, sealed.
    pub fn send(&mut self, text: &str) {
        let Sealed::Text(boxed) = self.channel.seal(text.as_bytes(), false).unwrap() else { panic!("text carrier") };
        self.peer.send_frame(&boxed);
    }

    /// The next application text frame the PC sent, opened.
    pub async fn recv(&mut self) -> String {
        match self.peer.next().await {
            Event::Frame(boxed) => String::from_utf8(self.channel.open(Wire::Text(&boxed)).unwrap()).unwrap(),
            Event::Closed(reason) => panic!("the PC closed the phone: {reason}"),
        }
    }

    /// The reason the PC closed this phone, after any application frames it still had for it.
    pub async fn closed(&mut self) -> String {
        loop {
            if let Event::Closed(reason) = self.peer.next().await {
                return reason;
            }
        }
    }

    /// Every frame for this phone that reached the relay so far, application frames and closes alike.
    pub async fn arrived(&self) -> usize {
        self.peer.arrived().await
    }

    /// The relay reports the phone gone.
    pub fn leave(&self) {
        self.peer.out.send(json!({ "type": "client-close", "clientId": self.peer.id })).unwrap();
    }
}
/// A runtime over the remote-access files in `dir`, dialing the relay at `ws://127.0.0.1:{port}`.
pub fn runtime_for(dir: PathBuf, port: u16, dialer: Arc<dyn Dialer>) -> RemoteRuntime {
    runtime_with(dir, port, dialer, Arc::new(DeviceRegistry::default()))
}

/// [`runtime_for`] over a registry the caller shares with its dialer.
pub fn runtime_with(dir: PathBuf, port: u16, dialer: Arc<dyn Dialer>, registry: Arc<DeviceRegistry>) -> RemoteRuntime {
    let cfg = RuntimeConfig {
        dir: dir.clone(),
        relay_url: Some(format!("ws://127.0.0.1:{port}")),
        app_version: None,
        durability: mixdog_rt::testing::tokens().durability_io,
        dialer,
        registry,
        section: Arc::new(RemoteSection::new(Arc::new(Silent), RemoteSectionValue::default())),
        settings: Arc::new(AccessSettings::new(dir, Arc::new(|| "PC".to_owned()))),
        link: LegLink::default(),
        events: Arc::new(Quiet),
    };
    RemoteRuntime::new(cfg, Box::new(|_| Box::new(NoEffects)))
}
