//! Goldens recorded from Node by `benchmarks/rust-core/recorders/record-ai-account.mjs`.

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialIo;
use serde_json::Value;

use super::admin::acct;
use super::admin::parse_account_change;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/ai-account/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

/// JSON equality that reads `1` and `1.0` as the same number, as `JSON.stringify` does.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// The refusals of `account-admin.json` that need no collaborator: option checks, the key-env
/// name check and the flow-id check. (The vault/config paths are covered by the Node recording
/// only until a `ProviderAdmin` can be built over fakes.)
#[tokio::test]
async fn account_admin_refusals_match_node() {
    let fx = fixture("account-admin.json");
    for case in fx["cases"].as_array().unwrap() {
        let args = case["args"].as_array().unwrap();
        let got = match case["fn"].as_str().unwrap() {
            "checkCustomProviderKeyEnv" => {
                let name = args[0].as_str().ok_or_else(|| super::failure::Failure::type_error("environment variable name is invalid"));
                name.and_then(super::admin::ProviderAdmin::check_custom_provider_key_env)
            }
            "beginOAuthProviderLogin" if args.len() == 2 && args[1].get("accountId").is_none() => {
                super::admin::assert_login_options(&args[1]).map(|()| Value::Null)
            }
            _ => continue,
        };
        match (got, case.get("ok")) {
            (Ok(value), Some(want)) => assert!(same(&value, want), "{case}"),
            (Err(failure), None) => assert_eq!(case["error"]["message"], failure.message(), "{case}"),
            (got, _) => panic!("{case}: got {got:?}"),
        }
    }
    let flows = super::flows::OAuthFlows::default();
    for case in fx["flowCases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let got = match case["op"].as_str().unwrap() {
            "status" => flows.status(id),
            "cancel" => flows.cancel(id).await,
            _ => flows.complete(id, "code").await,
        };
        assert_eq!(case["error"]["message"], got.unwrap_err().message(), "{case}");
    }
}

#[tokio::test]
async fn account_roster_changes_match_node() {
    let fx = fixture("account-change.json");
    let provider = fx["provider"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(
        dir.path().to_path_buf(),
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    for entry in fx["steps"].as_array().unwrap() {
        let step = &entry["step"];
        let id = step["id"].as_str().unwrap_or("");
        let result = match step["op"].as_str().unwrap() {
            "register" => {
                let label = step["label"].as_str().unwrap_or("");
                store.register(provider, id, label, step["includeDefault"] == true).await.map_err(acct)
            }
            "change" => match parse_account_change(&step["change"]) {
                Ok(change) => store.change(provider, change).await.map_err(acct),
                Err(e) => Err(e),
            },
            "clearQuota" => store.clear_quota_state(provider, id).await.map_err(acct),
            "remove" => store.remove(provider, id).await.map_err(acct),
            other => panic!("{other}"),
        };
        match (result, entry.get("pool")) {
            (Ok(_), Some(want)) => {
                let got = serde_json::to_value(store.pool(provider).await.unwrap()).unwrap();
                assert!(same(&got, want), "{step}\n got {got}\nwant {want}");
            }
            (Err(e), None) => assert_eq!(entry["error"]["message"], e.message(), "{step}"),
            (got, _) => panic!("{step}: got {got:?}, want {entry}"),
        }
    }
}
