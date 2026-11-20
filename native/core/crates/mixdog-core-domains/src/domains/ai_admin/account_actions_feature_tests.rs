//! The provider-account setup actions (`forget_provider_auth`, `set_provider_account`): the checks and receipts over the
//! provider admin, and what each call asks of it.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::setup_actions::{SetupActions, SetupCall};
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::account_actions::{AccountActions, AccountOps, ProviderRows, public_accounts};

#[derive(Default)]
struct Ops {
    managed: bool,
    oauth: Vec<String>,
    accounts: Vec<String>,
    forget_error: Option<String>,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl AccountOps for Ops {
    async fn setup(&self) -> ProviderRows {
        ProviderRows { managed_by_client: self.managed, oauth: self.oauth.clone() }
    }
    async fn accounts(&self, id: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("accounts {id}"));
        let rows: Vec<Value> = self.accounts.iter().map(|account| json!({ "id": account })).collect();
        Ok(json!({ "accounts": rows }))
    }
    async fn forget(&self, id: &str, account: Option<&str>) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("forget {id} {}", account.unwrap_or("-")));
        match &self.forget_error {
            Some(error) => Err(error.clone()),
            None if account.is_some() => Ok(json!({ "provider": id, "type": "oauth", "forgotten": true, "removed": true })),
            None => Ok(json!({ "provider": id, "type": "api-key", "forgotten": true })),
        }
    }
    async fn update(&self, id: &str, change: &Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("update {id} {change}"));
        Ok(json!({
            "accounts": [{ "id": "a1", "label": "One", "authenticated": true, "usage": { "windows": [] }, "email": "x@y" }, { "id": "a2", "label": null }],
            "selectedId": "a1", "auto": true, "policy": "headroom"
        }))
    }
}

fn actions(ops: Ops) -> (AccountActions, Arc<Ops>) {
    let ops = Arc::new(ops);
    let schema = serde_json::from_str::<Value>(include_str!("../../../../mixdog-tools/src/orch/defs/setup.json")).unwrap()["inputSchema"].clone();
    (AccountActions::new(ops.clone(), schema), ops)
}

fn message(error: PortError) -> String {
    match error {
        PortError::Failed { message, .. } => message,
        PortError::Invalid { reason, .. } => reason,
        other => panic!("{other:?}"),
    }
}

async fn run(actions: &AccountActions, args: Value) -> Result<Value, String> {
    let thread = ThreadId::from("sess_caller");
    let action = args["action"].as_str().unwrap().to_owned();
    actions.run(&SetupCall { action: &action, args: &args, thread: &thread }).await.map_err(message)
}

fn oauth_ops(accounts: &[&str]) -> Ops {
    Ops { oauth: vec!["openai-oauth".into(), "anthropic-oauth".into()], accounts: accounts.iter().map(|id| (*id).to_owned()).collect(), ..Ops::default() }
}

#[tokio::test]
async fn forgetting_an_oauth_provider_with_one_account_needs_no_account_id() {
    let (actions, ops) = actions(oauth_ops(&["acc-1"]));
    let receipt = run(&actions, json!({ "action": "forget_provider_auth", "name": " openai-oauth " })).await.unwrap();
    assert_eq!(receipt, json!({ "provider": "openai-oauth", "type": "oauth", "forgotten": true, "removed": true, "accountId": "acc-1" }));
    assert_eq!(*ops.calls.lock().unwrap(), ["accounts openai-oauth", "forget openai-oauth acc-1"]);
}

#[tokio::test]
async fn with_several_accounts_the_account_id_must_be_passed() {
    let (actions, ops) = actions(oauth_ops(&["a", "b", "c"]));
    assert_eq!(
        run(&actions, json!({ "action": "forget_provider_auth", "name": "openai-oauth" })).await.unwrap_err(),
        "openai-oauth has 3 accounts; pass accountId from status providers"
    );
    let receipt = run(&actions, json!({ "action": "forget_provider_auth", "name": "openai-oauth", "accountId": " b " })).await.unwrap();
    assert_eq!(receipt["accountId"], "b", "the id is trimmed");
    assert_eq!(*ops.calls.lock().unwrap().last().unwrap(), "forget openai-oauth b");
    assert_eq!(
        run(&actions, json!({ "action": "forget_provider_auth", "name": "openai-oauth", "accountId": "  " })).await.unwrap_err(),
        "accountId is required"
    );
}

#[tokio::test]
async fn an_oauth_provider_without_an_account_has_nothing_to_forget() {
    let (actions, ops) = actions(oauth_ops(&[]));
    assert_eq!(
        run(&actions, json!({ "action": "forget_provider_auth", "name": "anthropic-oauth" })).await.unwrap_err(),
        "anthropic-oauth has no connected account"
    );
    assert!(!ops.calls.lock().unwrap().iter().any(|call| call.starts_with("forget")));
}

#[tokio::test]
async fn a_provider_without_accounts_is_forgotten_whole_and_refuses_an_account_id() {
    let (actions, ops) = actions(oauth_ops(&["a"]));
    let receipt = run(&actions, json!({ "action": "forget_provider_auth", "name": "openai" })).await.unwrap();
    assert_eq!(receipt, json!({ "provider": "openai", "type": "api-key", "forgotten": true }));
    assert_eq!(*ops.calls.lock().unwrap(), ["forget openai -"]);
    assert_eq!(
        run(&actions, json!({ "action": "forget_provider_auth", "name": "openai", "accountId": "a" })).await.unwrap_err(),
        "accountId applies only to OAuth providers"
    );
}

#[tokio::test]
async fn a_name_is_required_and_a_failure_of_the_admin_is_the_answer() {
    let (actions, _) = actions(oauth_ops(&["a"]));
    for name in ["", "  "] {
        assert_eq!(run(&actions, json!({ "action": "forget_provider_auth", "name": name })).await.unwrap_err(), "name is required");
    }
    let (failing, _) = self::actions(Ops { forget_error: Some("unknown provider \"nope\"".into()), ..Ops::default() });
    assert_eq!(run(&failing, json!({ "action": "forget_provider_auth", "name": "nope" })).await.unwrap_err(), "unknown provider \"nope\"");
}

#[tokio::test]
async fn the_desktop_managed_accounts_are_not_changed_from_here() {
    let (actions, ops) = actions(Ops { managed: true, ..Ops::default() });
    let managed = "Manage provider accounts in the local desktop window.";
    assert_eq!(run(&actions, json!({ "action": "forget_provider_auth", "name": "openai-oauth" })).await.unwrap_err(), managed);
    assert_eq!(
        run(&actions, json!({ "action": "set_provider_account", "name": "openai-oauth", "providerAccount": { "auto": true } })).await.unwrap_err(),
        managed
    );
    assert!(ops.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_roster_change_answers_the_roster_without_its_usage_and_identities() {
    let (actions, ops) = actions(oauth_ops(&[]));
    let answer = run(&actions, json!({ "action": "set_provider_account", "name": "openai-oauth", "providerAccount": { "auto": true } })).await.unwrap();
    assert_eq!(
        answer,
        json!({ "selectedId": "a1", "auto": true, "policy": "headroom", "useCredits": false, "accounts": [{ "id": "a1", "label": "One", "authenticated": true }, { "id": "a2" }] })
    );
    assert_eq!(*ops.calls.lock().unwrap(), ["update openai-oauth {\"auto\":true}"]);
}

#[test]
fn the_public_roster_leaves_out_what_the_pool_does_not_hold() {
    assert_eq!(public_accounts(&json!({ "accounts": [] })), json!({ "useCredits": false, "accounts": [] }));
    let pool = json!({ "accounts": [{ "id": "a", "reauthRequired": true }], "selectedId": "a", "auto": false, "policy": "", "useCredits": true });
    assert_eq!(
        public_accounts(&pool),
        json!({ "selectedId": "a", "auto": false, "useCredits": true, "accounts": [{ "id": "a", "reauthRequired": true }] }),
        "an empty policy is not shown"
    );
}
