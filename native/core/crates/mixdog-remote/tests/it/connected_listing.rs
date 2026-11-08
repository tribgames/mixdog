//! The section's `info.connected` is Node's "the descriptor is answered": it turns true after the first successful
//! client listing on the relay leg, not when the runtime connects (`remote.descriptor()` is `null` until
//! `relay.listClients()` succeeds; recorded from Node in apps/desktop/src/main/protocol/fixtures/remote-info-node-states.json).

use crate::common;

use std::sync::Arc;

use common::{NoDial, NoEffects, Quiet};
use futures::{SinkExt, StreamExt};
use mixdog_core_api::state::{SectionChange, StatePublisher};
use mixdog_protocol::SectionName;
use mixdog_remote::access::runtime::{LegLink, RemoteRuntime, RuntimeConfig};
use mixdog_remote::access::settings::AccessSettings;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::section::{RemoteSection, RemoteSectionValue};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::tungstenite::Message;

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
async fn silent_relay() -> (u16, mpsc::UnboundedReceiver<Value>, mpsc::UnboundedSender<Value>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (asked_tx, asked) = mpsc::unbounded_channel();
    let (answer, mut answers) = mpsc::unbounded_channel::<Value>();
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
    (port, asked, answer)
}

#[tokio::test(flavor = "multi_thread")]
async fn connected_turns_true_after_a_client_listing_and_a_failed_first_one_is_retried_by_the_next_ask() {
    let dir = tempfile::tempdir().unwrap();
    let (port, mut asked, answer) = silent_relay().await;
    let wake = Arc::new(Wake::default());
    let cfg = RuntimeConfig {
        dir: dir.path().to_path_buf(),
        relay_url: Some(format!("ws://127.0.0.1:{port}")),
        app_version: None,
        durability: mixdog_rt::testing::tokens().durability_io,
        dialer: Arc::new(NoDial),
        registry: Arc::new(DeviceRegistry::default()),
        section: Arc::new(RemoteSection::new(wake.clone(), RemoteSectionValue::default())),
        settings: Arc::new(AccessSettings::new(dir.path().to_path_buf(), Arc::new(|| "PC".to_owned()))),
        link: LegLink::default(),
        events: Arc::new(Quiet),
    };
    let runtime = RemoteRuntime::new(cfg, Box::new(|_| Box::new(NoEffects)));
    let mut link = runtime.watch_connected();
    runtime.start(true).await.unwrap();
    link.wait_for(|up| *up).await.unwrap();
    assert!(runtime.is_connected());
    // The leg is open and nobody has asked for the client list: Node's descriptor is `null` here, and the runtime asks nothing
    // on its own (Node listed only when a window asked).
    loop {
        let info = runtime.section_value().info;
        if info["enabled"] == json!(true) {
            assert_eq!(info["connected"], json!(false), "a connected leg that has not answered a listing is not connected yet");
            break;
        }
        wake.0.notified().await;
    }
    assert!(asked.try_recv().is_err(), "opening the leg lists nothing");
    // A window asks and the relay never answers (a failed listing): still not connected.
    let failed = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.list_if_unanswered().await }
    });
    let first = asked.recv().await.expect("the ask lists");
    failed.abort();
    assert_eq!(runtime.section_value().info["connected"], json!(false));
    // Node retried on the next ask, not on a timer or a relay event: `list_if_unanswered` is that ask, and its own request is
    // the one the relay answers.
    let asking = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.list_if_unanswered().await }
    });
    let second = asked.recv().await.expect("the next ask lists again");
    assert_ne!(second["requestId"], first["requestId"]);
    answer.send(json!({ "type": "clients-list", "requestId": second["requestId"], "clients": [] })).unwrap();
    asking.await.unwrap();
    loop {
        if runtime.section_value().info["connected"] == json!(true) {
            break;
        }
        wake.0.notified().await;
    }    runtime.close().await;
}