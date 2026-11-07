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

/// A scripted relay: it accepts one leg, declares the capabilities, answers `list-clients` with
/// the rows it was given, reports every other frame, and writes what the test sends.
pub struct Relay {
    pub port: u16,
    pub seen: mpsc::UnboundedReceiver<Value>,
    pub out: mpsc::UnboundedSender<Value>,
}

pub async fn driven_relay(clients: Value) -> Relay {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen_tx, seen) = mpsc::unbounded_channel();
    let (out, mut out_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let caps = json!({ "type": "relay-capabilities", "textFrames": 1, "maxFrameBytes": 1_048_576 });
        ws.send(Message::Text(caps.to_string().into())).await.unwrap();
        loop {
            tokio::select! {
                message = ws.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                        if frame["type"] == "list-clients" {
                            let answer = json!({ "type": "clients-list", "requestId": frame["requestId"], "clients": clients });
                            ws.send(Message::Text(answer.to_string().into())).await.unwrap();
                        } else {
                            let _ = seen_tx.send(frame);
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                },
                send = out_rx.recv() => match send {
                    Some(frame) => ws.send(Message::Text(frame.to_string().into())).await.unwrap(),
                    None => break,
                },
            }
        }
    });
    Relay { port, seen, out }
}

/// A paired phone on an established E2EE channel through the scripted relay.
pub struct Phone {
    id: String,
    channel: Channel,
    out: mpsc::UnboundedSender<Value>,
    seen: mpsc::UnboundedReceiver<Value>,
}

impl Relay {
    /// The phone `id` of paired credential `credential` opens: challenge, hello, ready.
    pub async fn pair_phone(mut self, identity: &ServerIdentity, id: &str, credential: &str) -> Phone {
        self.out.send(json!({ "type": "client-open", "clientId": id, "browserClientId": credential })).unwrap();
        let challenge = Challenge::parse(serde_json::from_str(&frame_for(&mut self.seen, id).await).unwrap()).unwrap();
        let (hello, channel) =
            create_client_handshake(&identity.pairing(), &challenge, ClientHandshakeOptions::default()).unwrap();
        self.out.send(json_frame(id, &hello.to_string())).unwrap();
        let mut phone = Phone { id: id.to_owned(), channel, out: self.out, seen: self.seen };
        let ready: Value = serde_json::from_str(&phone.recv().await).unwrap();
        assert_eq!(ready["type"], "e2ee-ready");
        phone
    }
}

impl Phone {
    /// One application text frame, sealed.
    pub fn send(&mut self, text: &str) {
        let Sealed::Text(boxed) = self.channel.seal(text.as_bytes(), false).unwrap() else { panic!("text carrier") };
        self.out.send(json_frame(&self.id, &boxed)).unwrap();
    }

    /// The next application text frame the PC sent, opened.
    pub async fn recv(&mut self) -> String {
        let boxed = frame_for(&mut self.seen, &self.id).await;
        String::from_utf8(self.channel.open(Wire::Text(&boxed)).unwrap()).unwrap()
    }

    /// The relay reports the phone gone.
    pub fn leave(&self) {
        self.out.send(json!({ "type": "client-close", "clientId": self.id })).unwrap();
    }
}

async fn frame_for(seen: &mut mpsc::UnboundedReceiver<Value>, id: &str) -> String {
    // The relay's channel ends when the relay task does, which fails the test at once; no clock.
    loop {
        let frame = seen.recv().await.expect("relay closed");
        if frame["type"] == "frame" && frame["clientId"] == id {
            return frame["data"].as_str().unwrap().to_owned();
        }
    }
}

/// A runtime over the remote-access files in `dir`, dialing the relay at `ws://127.0.0.1:{port}`.
pub fn runtime_for(dir: PathBuf, port: u16, dialer: Arc<dyn Dialer>) -> RemoteRuntime {
    let cfg = RuntimeConfig {
        dir: dir.clone(),
        relay_url: Some(format!("ws://127.0.0.1:{port}")),
        app_version: None,
        durability: mixdog_rt::testing::tokens().durability_io,
        dialer,
        registry: Arc::new(DeviceRegistry::default()),
        section: Arc::new(RemoteSection::new(Arc::new(Silent), RemoteSectionValue::default())),
        settings: Arc::new(AccessSettings::new(dir, Arc::new(|| "PC".to_owned()))),
        link: LegLink::default(),
        events: Arc::new(Quiet),
    };
    RemoteRuntime::new(cfg, Box::new(|_| Box::new(NoEffects)))
}
