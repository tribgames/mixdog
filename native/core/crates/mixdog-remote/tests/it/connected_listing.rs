//! The section's `info.connected` means "the descriptor is answered": it turns true after the first successful
//! client listing on the relay leg, not when the runtime connects (`remote.descriptor()` is `null` until
//! `relay.listClients()` succeeds).

use crate::common;

use std::sync::Arc;
use std::time::Duration;

use common::{NoDial, NoEffects, Quiet};
use futures::{SinkExt, StreamExt};
use mixdog_core_api::state::{SectionChange, StatePublisher};
use mixdog_protocol::SectionName;
use mixdog_remote::access::runtime::{LegLink, RemoteRuntime, RuntimeConfig};
use mixdog_remote::access::settings::AccessSettings;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::section::{RemoteSection, RemoteSectionValue};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

const WAIT: Duration = Duration::from_secs(10);

/// Wakes the test on every publish of the section.
#[derive(Default)]
struct Wake(Notify);

impl StatePublisher for Wake {
    fn publish(&self, _: SectionName, _: Option<String>, _: SectionChange) {
        self.0.notify_one();
    }
}

/// A relay that accepts one leg, declares its capabilities and answers nothing it is not told to: a `list-clients` request is
/// handed to the test, which answers it when it chooses.
async fn silent_relay() -> (u16, oneshot::Sender<()>, mpsc::UnboundedReceiver<Value>, mpsc::UnboundedSender<Value>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (asked_tx, asked) = mpsc::unbounded_channel();
    let (answer, mut answers) = mpsc::unbounded_channel::<Value>();
    let (open, opening) = oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        opening.await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let caps = json!({ "type": "relay-capabilities", "textFrames": 1, "maxFrameBytes": 1_048_576 });
        ws.send(Message::Text(caps.to_string().into())).await.unwrap();
        loop {
            tokio::select! {
                message = ws.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                        if frame["type"] == "list-clients" {
                            let _ = asked_tx.send(frame);
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                },
                send = answers.recv() => match send {
                    Some(frame) => ws.send(Message::Text(frame.to_string().into())).await.unwrap(),
                    None => break,
                },
            }
        }
    });
    (port, open, asked, answer)
}

fn runtime(dir: &std::path::Path, port: u16, wake: Arc<Wake>) -> RemoteRuntime {
    let cfg = RuntimeConfig {
        dir: dir.to_path_buf(),
        relay_url: Some(format!("ws://127.0.0.1:{port}")),
        app_version: None,
        durability: mixdog_rt::testing::tokens().durability_io,
        dialer: Arc::new(NoDial),
        registry: Arc::new(DeviceRegistry::default()),
        section: Arc::new(RemoteSection::new(wake, RemoteSectionValue::default())),
        settings: Arc::new(AccessSettings::new(dir, Arc::new(|| "PC".to_owned()))),
        link: LegLink::default(),
        events: Arc::new(Quiet),
    };
    RemoteRuntime::new(cfg, Box::new(|_| Box::new(NoEffects)))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_before_open_is_followed_by_a_ready_publication_without_another_read() {
    let dir = tempfile::tempdir().unwrap();
    let (port, open, mut asked, answer) = silent_relay().await;
    let wake = Arc::new(Wake::default());
    let runtime = runtime(dir.path(), port, wake.clone());
    runtime.start(true).await.unwrap();
    runtime.list_if_unanswered().await;
    assert_eq!(runtime.section_value().info["connected"], json!(false));
    open.send(()).unwrap();
    let request = mixdog_rt::time::timeout(WAIT, asked.recv()).await.expect("the open leg must list without a second read").expect("relay ended");
    assert_eq!(runtime.section_value().info["connected"], json!(false), "only a successful listing makes the QR ready");
    let paired = json!({ "id": "0123456789abcdef0123456789abcdef", "name": "Pixel 9 · Mixdog App", "browser": "Mixdog App", "createdAt": 5, "online": true });
    answer.send(json!({ "type": "clients-list", "requestId": request["requestId"], "clients": [paired] })).unwrap();
    mixdog_rt::time::timeout(WAIT, async {
        loop {
            let section = runtime.section_value();
            if section.info["connected"] == json!(true) {
                assert_eq!(section.clients[0]["id"], paired["id"]);
                assert_eq!(section.clients[0]["online"], json!(true));
                break;
            }
            wake.0.notified().await;
        }
    })
    .await
    .expect("a successful listing must publish the ready descriptor and roster");
    runtime.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_state_read_can_retry_an_unanswered_listing() {
    let dir = tempfile::tempdir().unwrap();
    let (port, open, mut asked, answer) = silent_relay().await;
    let runtime = runtime(dir.path(), port, Arc::new(Wake::default()));
    runtime.start(true).await.unwrap();
    open.send(()).unwrap();
    let first = mixdog_rt::time::timeout(WAIT, asked.recv()).await.expect("the initial listing").expect("relay ended");
    answer.send(json!({ "type": "clients-list", "requestId": first["requestId"], "ok": false })).unwrap();
    assert_eq!(runtime.section_value().info["connected"], json!(false));
    let asking = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.list_if_unanswered().await }
    });
    let second = mixdog_rt::time::timeout(WAIT, asked.recv()).await.expect("the next ask lists again").expect("relay ended");
    assert_ne!(second["requestId"], first["requestId"]);
    answer.send(json!({ "type": "clients-list", "requestId": second["requestId"], "clients": [] })).unwrap();
    asking.await.unwrap();
    assert_eq!(runtime.section_value().info["connected"], json!(true));
    runtime.close().await;
}
