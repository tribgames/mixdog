//! `status providers` against the Node recording (`fixtures/provider-status/provider-status-twin.json`):
//! Node's setup executor read each case over a scripted provider setup, the quota switch and its
//! real `listProviderAccounts` on a seeded data dir. The replay answers the facade calls as the
//! recording did, in order, so the order and arguments of the reads are compared as well as the
//! answer (key order included).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_config::config::Config;
use mixdog_rt::LaneToken as _;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::provider_status::{ProviderRoster, ProvidersStatus, QuotaAutoResumeSetting};
use crate::domains::ai_account::collaborators::ProviderSetup;
use crate::domains::ai_account::failure::Failure;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/provider-status/provider-status-twin.json")).unwrap()
}

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
impl ProviderSetup for Replay {
    async fn get(&self, force: bool, refresh: bool, unlock: bool, recheck: bool) -> Result<Value, Failure> {
        assert!(!(force || refresh || unlock || recheck), "Node asks for getProviderSetup({{}})");
        Ok(self.take("getProviderSetup", json!([{}])).unwrap())
    }
}

#[async_trait]
impl ProviderRoster for Replay {
    async fn accounts(&self, id: &str) -> Result<Value, String> {
        self.take("getProviderAccounts", json!([id]))
    }
}

impl QuotaAutoResumeSetting for Replay {
    fn enabled(&self) -> bool {
        self.take("getQuotaAutoResume", json!([])).unwrap().as_bool().unwrap()
    }
}

#[tokio::test]
async fn the_providers_status_matches_node() {
    let twin = twin();
    let cases = twin["cases"].as_array().unwrap();
    assert!(cases.len() > 190);
    let mut errors = 0;
    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        // The setup tool's input check answers before the reader is asked.
        if case["error"].as_str().is_some_and(|e| e.starts_with("[tool-input-validation]")) {
            continue;
        }
        let replay = Arc::new(Replay { calls: case["facade"].as_array().unwrap().clone(), next: Mutex::new(0) });
        let status = ProvidersStatus::new(replay.clone(), replay.clone(), replay.clone());
        let got = status.read(case["args"]["detail"] == json!(true)).await;
        match (case.get("error"), got) {
            (Some(want), Err(e)) => {
                errors += 1;
                let mixdog_tools::orch::util::PortError::Failed { message, .. } = e else { panic!("case {i}: {name}: {e:?}") };
                assert_eq!(&json!(message), want, "case {i}: {name}");
            }
            (None, Ok(v)) => assert_eq!(v.to_string(), case["value"].to_string(), "case {i}: {name}"),
            (want, got) => panic!("case {i}: {name}: wanted {want:?}, got {got:?}"),
        }
        assert_eq!(*replay.next.lock().unwrap(), replay.calls.len(), "case {i}: {name}: facade calls left over");
    }
    assert_eq!(errors, 2, "the roster's refusal reaches the caller");
}

/// The roster reads `set_media_default` makes are Node's `listProviderAccounts`: the recording
/// holds each answer so the check an account id is made against can be replayed.
#[test]
fn the_recorded_rosters_are_what_the_account_check_reads() {
    let twin = twin();
    let rosters = twin["rosters"].as_array().unwrap();
    assert!(rosters.len() > 100);
    for entry in rosters {
        match entry.get("error") {
            Some(error) => assert_eq!(error, "Unknown OAuth provider.", "{entry}"),
            None => {
                let accounts = entry["result"]["accounts"].as_array().unwrap();
                assert_eq!(entry["result"]["provider"], entry["id"], "{entry}");
                // Client mode lists none, whatever the data dir holds.
                assert!(!entry["proxy"].as_bool().unwrap() || accounts.is_empty(), "{entry}");
            }
        }
    }
}

#[tokio::test]
async fn the_quota_switch_is_on_unless_the_config_says_false() {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::ConfigLanes;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    // Node: `config.quotaResume?.autoResume !== false`.
    for (agent, want) in [
        (json!({}), true),
        (json!({ "quotaResume": {} }), true),
        (json!({ "quotaResume": { "autoResume": true } }), true),
        (json!({ "quotaResume": { "autoResume": null } }), true),
        (json!({ "quotaResume": { "autoResume": 0 } }), true),
        (json!({ "quotaResume": { "autoResume": false } }), false),
    ] {
        let path = dir.path().join("mixdog-config.json");
        let bytes = serde_json::to_vec(&json!({ "agent": agent })).unwrap();
        let file = path.clone();
        tokens
            .durability_io
            .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &file, &bytes, &mixdog_statefile::Opts::default()))
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        assert_eq!(QuotaAutoResumeSetting::enabled(&config), want, "{agent}");
    }
}
