//! The provider-account setup actions against the Node recording
//! (`fixtures/account-actions/account-actions-twin.json`): Node's setup executor ran each case over its
//! real provider-admin functions on a throwaway data dir. The fake [`AccountOps`] answers each
//! call as the recording's facade did and refuses a call the executor did not make at that point,
//! so the order and arguments of the facade calls are compared as well as the answer.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::setup_actions::{SetupActions, SetupCall};
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::account_actions::{AccountActions, AccountOps, ProviderRows};

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/account-actions/account-actions-twin.json")).unwrap()
}

fn message(error: PortError) -> String {
    match error {
        PortError::Failed { message, .. }
        | PortError::Unavailable { message, .. }
        | PortError::Refused { message, .. }
        | PortError::NotFound { message, .. } => message,
        PortError::Invalid { reason, .. } => reason,
        PortError::Denied(message) => message,
        PortError::Cancelled => "cancelled".into(),
    }
}

/// The recorded facade calls, answered in order.
struct Replay {
    calls: Vec<Value>,
    next: Mutex<usize>,
}

impl Replay {
    fn take(&self, call: &str, args: Value) -> Result<Value, String> {
        let mut next = self.next.lock().unwrap();
        let entry = self.calls.get(*next).unwrap_or_else(|| panic!("unexpected {call} {args}"));
        assert_eq!((entry["call"].as_str().unwrap(), &entry["args"]), (call, &args), "call {}", *next);
        *next += 1;
        match entry.get("error") {
            Some(error) => Err(error.as_str().unwrap().to_owned()),
            None => Ok(entry["result"].clone()),
        }
    }
}

#[async_trait]
impl AccountOps for Replay {
    async fn setup(&self) -> ProviderRows {
        let setup = self.take("getProviderSetup", json!([{}])).unwrap();
        ProviderRows {
            managed_by_client: setup["managedByClient"] == json!(true),
            oauth: setup["oauth"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()).collect(),
        }
    }

    async fn accounts(&self, id: &str) -> Result<Value, String> {
        self.take("getProviderAccounts", json!([id]))
    }

    async fn forget(&self, id: &str, account: Option<&str>) -> Result<Value, String> {
        let args = account.map_or(json!([id]), |account| json!([id, account]));
        self.take("forgetProviderAuth", args)
    }

    async fn update(&self, id: &str, change: &Value) -> Result<Value, String> {
        self.take("updateProviderAccounts", json!([id, change]))
    }
}

#[tokio::test]
async fn the_account_setup_actions_match_node() {
    let schema = serde_json::from_str::<Value>(include_str!("../../../../mixdog-tools/src/orch/defs/setup.json")).unwrap()["inputSchema"].clone();
    let twin = twin();
    let cases = twin["cases"].as_array().unwrap();
    assert!(cases.len() > 200);
    let thread = ThreadId::from("sess_caller");
    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let replay = Arc::new(Replay { calls: case["facade"].as_array().unwrap().clone(), next: Mutex::new(0) });
        let actions = AccountActions::new(replay.clone(), schema.clone());
        let args = &case["args"];
        let got = actions.run(&SetupCall { action: args["action"].as_str().unwrap(), args, thread: &thread }).await;
        match (case.get("error"), got) {
            (Some(want), Err(e)) => assert_eq!(&json!(message(e)), want, "case {i}: {name}"),
            (None, Ok(v)) => assert_eq!(v.to_string(), case["value"].to_string(), "case {i}: {name}"),
            (want, got) => panic!("case {i}: {name}: wanted {want:?}, got {got:?}"),
        }
        assert_eq!(*replay.next.lock().unwrap(), replay.calls.len(), "case {i}: {name}: facade calls left over");
    }
}
