//! LR §9 tests 2 and 6 (the second test below is test 6). Test 2, origin scoping, end to end: a paired phone's E2EE frames cross the relay and the
//! in-process bridge into the real server over the mock core, and every method the table does not
//! offer over the relay (the audit write, the management requests) is refused `permissionDenied`
//! on that connection. Nothing the phone sends can reach a method outside its origin.

use std::collections::BTreeSet;
use std::sync::Arc;

use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::v1::{CapabilityState, ServerCapabilities};
use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_server::{AppServer, Inbound, Outgoing, ServerConfig, VersionOrder};
use mixdog_app_server_transport::relay::{RelayEndpoint, RelayOut, open_relay};
use mixdog_app_server_transport::{AcceptedConnection, ConnectionHub};
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::{MockCore, MockLimits, event};
use mixdog_core_api::{Feed, FeedSource, Reply, Subscribe};
use mixdog_protocol::Origin;
use mixdog_remote::bridge::local::{Accept, LocalDialer};
use mixdog_remote::identity::load_or_create_e2ee_identity;
use serde_json::{Value, json};

use crate::common;
use common::{driven_relay, on_lane, runtime_with};
use mixdog_remote::registry::DeviceRegistry;

const VERSION: &str = "1.4.6";
const CRED: &str = "aaaaaaa1";

fn server_config() -> ServerConfig {
    let available = || CapabilityState::Available;
    ServerConfig {
        user_agent: "mixdog-test".to_owned(),
        platform_family: "windows".to_owned(),
        platform_os: "windows".to_owned(),
        server_version: VERSION.to_owned(),
        server_build: "test".to_owned(),
        server_instance_id: "instance-1".to_owned(),
        defaults_separation: Default::default(),
        capabilities: ServerCapabilities {
            office: available(),
            js_skills: available(),
            browser: available(),
            computer: available(),
            voice: available(),
            remote: Default::default(),
            window_scope: 1,
        },
        native_push: Arc::new(|| false),
        limits: Limits::default(),
        version_gate: Arc::new(|_| VersionOrder::Equal),
    }
}

/// One connection's life, as the daemon drives it.
async fn drive(server: AppServer, accepted: AcceptedConnection) {
    let AcceptedConnection { id, mut inbound, sink, .. } = accepted;
    let handle = server.open(id, Arc::new(sink.clone()));
    while let Some(message) = inbound.recv().await {
        match handle.on_message(message) {
            Inbound::Continue => {}
            Inbound::Pause(resume) => resume.await,
            Inbound::Close(code) => {
                sink.close(code);
                break;
            }
        }
    }
}

/// LR §9 test 6 at the wire: a phone through the relay and a second connection straight on the
/// hub subscribe to the same thread and receive the same frames, snapshot then live events, so
/// both folds start from identical input. Only the per-connection subscription id may differ.
#[tokio::test(flavor = "multi_thread")]
async fn a_phone_and_a_direct_connection_receive_the_same_thread_frames() {
    mixdog_rt::testing::tokens();
    let core = Arc::new(MockCore::new(&[], MockLimits::default()));
    let thread = core.directory().insert(ThreadId::from("t1"));
    let feed: Arc<dyn FeedSource> = thread.feed().clone();
    thread.set_handler(Arc::new(move |_| {
        Ok(Reply::Subscribe(Subscribe {
            result: json!({ "thread": { "id": "t1" } }),
            feed: feed.clone(),
            window: Window::LastItems(10),
            resume_from: None,
        }))
    }));
    thread.feed().publish(&[event(1), event(2)], None).unwrap();
    let hub = ConnectionHub::new(Limits::default()).unwrap();
    let origins = hub.clone();
    let server = AppServer::new(
        core,
        Outgoing::new(),
        Arc::new(move |id| origins.origin_of(id)),
        server_config(),
    )
    .unwrap();
    let accept: Accept = {
        let server = server.clone();
        Arc::new(move |accepted| {
            tokio::spawn(drive(server.clone(), accepted));
        })
    };

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let relay = driven_relay(json!([])).await;
    let devices = Arc::new(DeviceRegistry::default());
    let runtime = runtime_with(path, relay.port, Arc::new(LocalDialer::new(hub.clone(), accept.clone(), devices.clone())), devices);
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
    let mut phone = relay.pair_phone(&identity, "p1", CRED).await;

    let (accepted, mut direct) = open_relay(&hub, "desk1".to_owned()).unwrap();
    accept(accepted);

    let initialize = json!({
        "id": 0, "method": "initialize",
        "params": { "clientInfo": { "name": "client", "version": VERSION, "kind": "phone" }, "capabilities": {} },
    })
    .to_string();
    let resume = json!({ "id": 1, "method": "thread/resume", "params": { "threadId": "t1", "window": { "lastItems": 10 } } }).to_string();
    phone.send(&initialize);
    direct.send_text(initialize).await.unwrap();
    phone.send(&resume);
    direct.send_text(resume).await.unwrap();

    // initialize answer, resume answer, snapshot; then one live event after both are attached.
    let mut from_phone = Vec::new();
    let mut from_direct = Vec::new();
    for _ in 0..3 {
        from_phone.push(phone.recv().await);
        from_direct.push(next_text(&mut direct).await);
    }
    thread.feed().publish(&[event(3)], None).unwrap();
    from_phone.push(phone.recv().await);
    from_direct.push(next_text(&mut direct).await);

    // The mock feed's snapshot and event frames are plain labels ("snapshot@2"), not JSON.
    let same = |frames: Vec<String>| -> Vec<Value> {
        frames
            .iter()
            .map(|text| {
                let mut frame: Value = serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.clone()));
                if let Some(id) = frame.pointer_mut("/result/subscription/id") {
                    *id = Value::Null;
                }
                frame
            })
            .collect()
    };
    let (phone_view, direct_view) = (same(from_phone), same(from_direct));
    assert_eq!(phone_view, direct_view);
    assert!(phone_view[1]["result"]["subscription"].is_object(), "{}", phone_view[1]);
    assert!(phone_view.len() == 4, "snapshot and the live event arrived on both");
}

async fn next_text(endpoint: &mut RelayEndpoint) -> String {
    loop {
        match endpoint.recv().await.expect("the connection ended") {
            RelayOut::Text(bytes) => return String::from_utf8(bytes.to_vec()).unwrap(),
            RelayOut::Ping => endpoint.send_activity().await.unwrap(),
            RelayOut::Close(code) => panic!("closed: {code:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_is_a_relay_connection_and_methods_outside_that_origin_are_refused() {
    mixdog_rt::testing::tokens();
    let core = Arc::new(MockCore::new(&[], MockLimits::default()));
    let hub = ConnectionHub::new(Limits::default()).unwrap();
    let origins = hub.clone();
    let server = AppServer::new(
        core,
        Outgoing::new(),
        Arc::new(move |id| origins.origin_of(id)),
        server_config(),
    )
    .unwrap();
    let accept: Accept = {
        let server = server.clone();
        Arc::new(move |accepted| {
            tokio::spawn(drive(server.clone(), accepted));
        })
    };

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let identity = {
        let path = path.clone();
        on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
    };
    let relay = driven_relay(json!([])).await;
    let devices = Arc::new(DeviceRegistry::default());
    let runtime = runtime_with(path, relay.port, Arc::new(LocalDialer::new(hub, accept, devices.clone())), devices);
    runtime.start(true).await.unwrap();
    runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
    let mut phone = relay.pair_phone(&identity, "p1", CRED).await;

    phone.send(
        &json!({
            "id": 0, "method": "initialize",
            "params": { "clientInfo": { "name": "phone", "version": VERSION, "kind": "phone" }, "capabilities": {} },
        })
        .to_string(),
    );
    let initialized: Value = serde_json::from_str(&phone.recv().await).unwrap();
    assert_eq!(initialized["id"], 0);
    assert!(initialized.get("result").is_some(), "{initialized}");

    let withheld: Vec<&str> = CLIENT_METHODS.iter().filter(|spec| !spec.allows(Origin::Relay)).map(|spec| spec.method).collect();
    assert!(withheld.contains(&"agent/recordAgentApprovalAudit"), "the audit write is not offered over the relay");
    for (index, method) in withheld.iter().enumerate() {
        phone.send(&json!({ "id": index + 1, "method": method, "params": {} }).to_string());
    }
    let mut refused = BTreeSet::new();
    while refused.len() < withheld.len() {
        let answer: Value = serde_json::from_str(&phone.recv().await).unwrap();
        let method = withheld[answer["id"].as_u64().unwrap() as usize - 1];
        assert_eq!(
            answer["error"]["data"],
            json!({ "reason": "permissionDenied", "method": method, "origin": "relay" }),
            "{method}: {answer}"
        );
        refused.insert(method);
    }

    // The connection itself works: a method the table offers over the relay is served.
    phone.send(&json!({ "id": 100_000, "method": "thread/list", "params": {} }).to_string());
    let listed: Value = serde_json::from_str(&phone.recv().await).unwrap();
    assert!(listed.get("result").is_some(), "{listed}");
}
