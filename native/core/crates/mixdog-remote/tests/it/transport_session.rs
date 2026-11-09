//! A transport session on the relay carrier, end to end: the PC's session is opened over a real
//! E2EE channel pair, its first message is the `e2ee-ready` record 1, a phone built from the same
//! stream cores opens it, sends a record that reaches the core byte for byte, and receives what the
//! core sends back, in order.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_remote::e2ee::Challenge;
use mixdog_remote::e2ee::ClientHandshakeOptions;
use mixdog_remote::e2ee::Sealed;
use mixdog_remote::e2ee::ServerIdentity;
use mixdog_remote::e2ee::Wire;
use mixdog_remote::e2ee::accept_client_hello;
use mixdog_remote::e2ee::create_client_handshake;
use mixdog_remote::media::ByteSource;
use mixdog_remote::media::MediaSources;
use mixdog_remote::media::SourceFailure;
use mixdog_remote::transport::coordinator::EndReason;
use mixdog_remote::transport::frame::Message;
use mixdog_remote::transport::frame::decode_message;
use mixdog_remote::transport::frame::encode_record;
use mixdog_remote::transport::receiver::Receiver;
use mixdog_remote::transport::session::SessionEnv;
use mixdog_remote::transport::session::TransportSession;
use mixdog_remote::webrtc::config::IceServer;
use serde_json::Value;
use serde_json::json;

struct NoSources;

#[async_trait]
impl MediaSources for NoSources {
    async fn gallery(&self, _: &str, _: &str) -> Result<Option<Box<dyn ByteSource>>, SourceFailure> {
        Ok(None)
    }

    async fn download(&self, _: &str, _: &str) -> Option<Box<dyn ByteSource>> {
        None
    }
}

#[derive(Default)]
struct Seen {
    relay: Vec<Vec<u8>>,
    delivered: Vec<String>,
    ended: Vec<String>,
    live: usize,
}

struct Env(Arc<Mutex<Seen>>, tokio::sync::watch::Sender<()>);

impl SessionEnv for Env {
    fn relay_write(&self, _: &str, message: Vec<u8>) -> BoxFuture<'static, bool> {
        self.0.lock().unwrap().relay.push(message);
        self.1.send_replace(());
        Box::pin(async { true })
    }

    fn deliver(&self, _: &str, text: String) -> BoxFuture<'static, ()> {
        self.0.lock().unwrap().delivered.push(text);
        self.1.send_replace(());
        Box::pin(async {})
    }

    fn ended(&self, _: &str, reason: &str) {
        self.0.lock().unwrap().ended.push(reason.to_owned());
    }

    fn resolve_ice(&self) -> BoxFuture<'static, Vec<IceServer>> {
        Box::pin(async { Vec::new() })
    }

    fn live(&self, _: &str) {
        self.0.lock().unwrap().live += 1;
    }

    fn background(&self, _: &str) {}

    fn media_sources(&self) -> Arc<dyn MediaSources> {
        Arc::new(NoSources)
    }
}

/// Opens every application record the PC wrote so far, in order.
fn opened_by_phone(seen: &Mutex<Seen>, receiver: &mut Receiver, phone: &mut mixdog_remote::e2ee::Channel, taken: &mut usize) -> Vec<Value> {
    let relay = seen.lock().unwrap().relay.clone();
    for raw in &relay[*taken..] {
        if let Message::Record(record) = decode_message(raw).expect("a conforming message") {
            receiver.accept(&record, 0);
        }
    }
    *taken = relay.len();
    let mut out = Vec::new();
    while let Some((sequence, box_bytes)) = receiver.next().map(|(s, b)| (s, b.to_vec())) {
        let plain = phone.open(Wire::Binary(&box_bytes)).expect("the box opens");
        receiver.commit(sequence, 0).unwrap();
        out.push(serde_json::from_slice(&plain).unwrap());
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transport_session_carries_ready_and_both_directions_on_the_relay() {
    let identity = ServerIdentity::generate();
    let challenge = Challenge::create(&["binaryFrames", "transportWebrtc", "mediaE2ee"]);
    let (hello, mut phone) = create_client_handshake(&identity.pairing(), &challenge, ClientHandshakeOptions { transport: true, ..Default::default() }).unwrap();
    let pc = accept_client_hello(&identity, &challenge, &hello).unwrap();
    assert!(pc.transport_enabled());
    let confirmation = pc.handshake_confirmation().unwrap().to_owned();

    mixdog_rt::testing::tokens();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (changed, mut changes) = tokio::sync::watch::channel(());
    let session = TransportSession::open(Arc::new(Env(seen.clone(), changed)), "client-1", "cred-1".to_owned(), challenge.challenge(), pc);
    let ready = json!({ "type": "e2ee-ready", "version": 1, "transcript": confirmation });
    session.send(&ready.to_string(), false).await.unwrap();

    let mut receiver = Receiver::new();
    let mut taken = 0;
    let mut first = Vec::new();
    while first.is_empty() {
        changes.changed().await.unwrap();
        first = opened_by_phone(&seen, &mut receiver, &mut phone, &mut taken);
    }
    assert_eq!(first, vec![ready.clone()], "e2ee-ready is the stream's record 1");
    phone.confirm_handshake(&ready).unwrap();

    // The phone's request reaches the core as sent.
    let request = r#"{"jsonrpc":"2.0","id":1,"method":"thread/list","params":{}}"#;
    let Sealed::Binary(boxed) = phone.seal(request.as_bytes(), true).unwrap() else { panic!("binary") };
    for message in encode_record(&boxed).unwrap() {
        session.receive_relay(&message);
    }
    changes.wait_for(|_| !seen.lock().unwrap().delivered.is_empty()).await.unwrap();
    assert_eq!(seen.lock().unwrap().delivered, vec![request.to_owned()]);
    assert!(seen.lock().unwrap().live > 0, "an opened record is authenticated liveness");

    // The core's answer arrives after, in order.
    session.send(r#"{"jsonrpc":"2.0","id":1,"result":[]}"#, false).await.unwrap();
    session.send(r#"{"method":"event","params":{}}"#, false).await.unwrap();
    let mut next = Vec::new();
    while next.len() < 2 {
        changes.changed().await.unwrap();
        next.extend(opened_by_phone(&seen, &mut receiver, &mut phone, &mut taken));
    }
    assert_eq!(next, vec![json!({ "jsonrpc": "2.0", "id": 1, "result": [] }), json!({ "method": "event", "params": {} })]);

    session.close(EndReason::SessionEnded);
    assert!(session.is_closed());
    assert!(session.send("{}", false).await.is_err(), "nothing is sealed after the end");
}
