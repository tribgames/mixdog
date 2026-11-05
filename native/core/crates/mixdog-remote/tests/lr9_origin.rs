//! LR §9 test 2, origin scoping, end to end: a paired phone's E2EE frames cross the relay and the
//! in-process bridge into the real server over the mock core, and every method the table does not
//! offer over the relay (the audit write, the management requests) is refused `permissionDenied`
//! on that connection. Nothing the phone sends can reach a method outside its origin.

use std::collections::BTreeSet;
use std::sync::Arc;

use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::v1::{CapabilityState, ServerCapabilities};
use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_server::{AppServer, Inbound, Outgoing, ServerConfig, VersionOrder};
use mixdog_app_server_transport::{AcceptedConnection, ConnectionHub};
use mixdog_core_api::mock::{MockCore, MockLimits};
use mixdog_protocol::Origin;
use mixdog_remote::bridge::local::{Accept, LocalDialer};
use mixdog_remote::identity::load_or_create_e2ee_identity;
use serde_json::{Value, json};

mod common;
use common::{driven_relay, eventually, on_lane, runtime_for};

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
        capabilities: ServerCapabilities {
            office: available(),
            js_skills: available(),
            browser: available(),
            computer: available(),
            voice: available(),
        },
        limits: Limits::default(),
        version_gate: Arc::new(|_| VersionOrder::Equal),
    }
}

/// One connection's life, as the daemon drives it.
async fn drive(server: AppServer, accepted: AcceptedConnection) {
    let AcceptedConnection { id, origin, mut inbound, sink } = accepted;
    let handle = server.open(id, origin.origin(), Arc::new(sink.clone()));
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

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_is_a_relay_connection_and_methods_outside_that_origin_are_refused() {
    mixdog_rt::testing::tokens();
    let core = Arc::new(MockCore::new(&[], MockLimits::default()));
    let server = AppServer::new(core, Outgoing::new(), server_config()).unwrap();
    let hub = ConnectionHub::new(Limits::default()).unwrap();
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
    let runtime = runtime_for(path, relay.port, Arc::new(LocalDialer::new(hub, accept)));
    runtime.start(true).await.unwrap();
    eventually("the leg did not open", || runtime.is_connected()).await;
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
