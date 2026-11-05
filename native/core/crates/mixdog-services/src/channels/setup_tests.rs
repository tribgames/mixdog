//! Node-recorded twin: `fixtures/channels/automation-setup-twin.json`
//! (`benchmarks/rust-core/recorders/record-automation-setup.mjs`).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::setup::{AccessScope, AgentDirectory, AutomationAdmin, AutomationSetup, assert_access};

fn twin() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/channels/automation-setup-twin.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn absent() -> Value {
    json!({"absent": true})
}

struct Agents(Vec<String>);

#[async_trait]
impl AgentDirectory for Agents {
    async fn agent_ids(&self) -> Vec<String> {
        self.0.clone()
    }
}

/// The fake runtime of the recorder: the same answers, and every call noted.
struct Fake {
    state: Value,
    calls: Mutex<Vec<Value>>,
}

impl Fake {
    fn note(&self, method: &str, args: Vec<Value>) {
        self.calls.lock().unwrap().push(json!({"method": method, "args": args}));
    }
    fn saved(entry: &Value) -> Value {
        let mut out = entry.as_object().unwrap().clone();
        if let Some(at) = entry.get("at").and_then(Value::as_str) {
            let t = DateTime::parse_from_rfc3339(at).unwrap().with_timezone(&Utc);
            out.insert("whenAt".into(), t.to_rfc3339_opts(SecondsFormat::Millis, true).into());
        }
        if let Some(time) = entry.get("time") {
            out.insert("whenCron".into(), time.clone());
        }
        out.insert("secret".into(), "sek".into());
        Value::Object(out)
    }
}

#[async_trait]
impl AutomationAdmin for Fake {
    async fn get_channel_setup(&self) -> Result<Value, String> {
        Ok(self.state.clone())
    }
    async fn save_schedule(&self, entry: &Value) -> Result<Value, String> {
        self.note("saveSchedule", vec![entry.clone()]);
        Ok(Self::saved(entry))
    }
    async fn save_webhook(&self, entry: &Value) -> Result<Value, String> {
        self.note("saveWebhook", vec![entry.clone()]);
        Ok(Self::saved(entry))
    }
    async fn delete_schedule(&self, name: &str) -> Result<Value, String> {
        self.note("deleteSchedule", vec![name.into()]);
        Ok(json!({"name": name, "deleted": true}))
    }
    async fn delete_webhook(&self, name: &str) -> Result<Value, String> {
        self.note("deleteWebhook", vec![name.into()]);
        Ok(json!({"name": name, "deleted": true}))
    }
    async fn set_schedule_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
        self.note("setScheduleEnabled", vec![name.into(), enabled.cloned().unwrap_or_else(absent)]);
        Ok(json!({"name": name, "enabled": enabled != Some(&Value::Bool(false))}))
    }
    async fn set_webhook_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
        self.note("setWebhookEnabled", vec![name.into(), enabled.cloned().unwrap_or_else(absent)]);
        Ok(json!({"name": name, "enabled": enabled != Some(&Value::Bool(false))}))
    }
    async fn run_schedule_now(&self, name: &str) -> Result<Value, String> {
        self.note("runScheduleNow", vec![name.into()]);
        std::future::pending().await
    }
    async fn run_webhook_now(&self, name: &str) -> Result<Value, String> {
        self.note("runWebhookNow", vec![name.into()]);
        std::future::pending().await
    }
    async fn set_webhook_config(&self, patch: Option<&Value>) -> Result<Value, String> {
        self.note("setWebhookConfig", vec![patch.cloned().unwrap_or_else(absent)]);
        Ok(Value::Null)
    }
}

fn scope_of(value: &Value) -> AccessScope {
    match value["kind"].as_str().unwrap() {
        "human" => AccessScope::Human,
        "agent" => AccessScope::Agent { agent_id: value["agentId"].as_str().unwrap().into() },
        "room-member" => AccessScope::RoomMember,
        _ => AccessScope::Headless,
    }
}

fn message(error: PortError) -> String {
    match error {
        PortError::Failed { message, .. } | PortError::Denied(message) => message,
        other => panic!("unexpected port error {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_action_answers_and_calls_the_runtime_as_node_does() {
    let twin = twin();
    let agents: Vec<String> = twin["agents"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().into()).collect();
    let cases = twin["cases"].as_array().unwrap();
    assert!(cases.len() > 500);
    for case in cases {
        let label = format!("{} {} {} {}", case["action"], case["args"], case["state"], case["context"]);
        let fake = Arc::new(Fake { state: twin["states"][case["state"].as_str().unwrap()].clone(), calls: Mutex::new(Vec::new()) });
        let setup = AutomationSetup::new(fake.clone(), Arc::new(Agents(agents.clone())));
        let thread = ThreadId::from(case["sessionId"].as_str().unwrap());
        let got = setup.run(case["action"].as_str().unwrap(), &case["args"], &thread, &scope_of(&case["scope"])).await;
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        match (&got, case.get("error")) {
            (Ok(value), None) => assert_eq!(value, &case["value"], "{label}"),
            (Err(error), Some(expected)) => assert_eq!(&message(error.clone()), expected.as_str().unwrap(), "{label}"),
            _ => panic!("{label}: got {got:?}, node {case}"),
        }
        assert_eq!(Value::Array(fake.calls.lock().unwrap().clone()), case["calls"], "{label}");
    }
}

#[test]
fn access_rules_and_refusal_texts_match_node() {
    let twin = twin();
    let agents: Vec<String> = twin["agents"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().into()).collect();
    for case in twin["accessCases"].as_array().unwrap() {
        let current = (!case["current"].is_null()).then(|| &case["current"]);
        let got = assert_access(
            &scope_of(&case["scope"]),
            case["kind"].as_str().unwrap(),
            case["action"].as_str().unwrap(),
            current,
            case["owner"].as_str().unwrap(),
            &agents,
        );
        match (got, case.get("error")) {
            (Ok(()), None) => {}
            (Err(error), Some(expected)) => assert_eq!(message(error), expected.as_str().unwrap(), "{case}"),
            (got, _) => panic!("{case}: got {got:?}"),
        }
    }
}
