//! Goldens recorded from Node by `benchmarks/rust-core/recorders/record-ai-account.mjs`.

#![allow(clippy::disallowed_methods, reason = "test setup: reads the recorded goldens on the test thread")]

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialIo;
use serde_json::Value;

use super::admin::acct;
use super::admin::parse_account_change;

fn fixture(name: &str) -> Value {
    fixture_at(&format!("ai-account/{name}"))
}

fn fixture_at(relative: &str) -> Value {
    let path = format!("{}/../../fixtures/{relative}", env!("CARGO_MANIFEST_DIR"));
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
    let flows = super::flows::OAuthFlows::new(
        std::time::Duration::from_millis(super::flows::DEFAULT_FLOW_TTL_MS),
        std::sync::Arc::new(mixdog_core_api::feed_publisher::LoginFeeds::new(std::sync::Arc::new(
            mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default()),
        ))),
    );
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

/// A roster read that never ran is not the "default" account: a login, a forget or a credit
/// redemption on "default" would act on a different account than the selected one.
#[tokio::test]
async fn an_unread_roster_is_not_the_default_account() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(
        dir.path().to_path_buf(),
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    {
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        let error = super::admin::selected_of(store.pool("openai-oauth").await).unwrap_err();
        assert!(error.unrun(), "{error}");
    }
    // A roster that was read and has no selection is "default".
    assert_eq!(super::admin::selected_of(store.pool("openai-oauth").await).unwrap(), "default");
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

/// The login:<flowId> feed of a provider sign-in publishes, after each step, the status Node's registry answered
/// (`benchmarks/rust-core/recorders/record-login-status.mjs`), and a subscriber that attaches late sees the
/// status the flow ended with.
#[tokio::test(flavor = "multi_thread")]
async fn provider_sign_in_feeds_publish_the_statuses_node_answered() {
    use mixdog_core_api::domain::login::LoginState;
    use mixdog_core_api::domain::mock::LiveLoginSession;
    use mixdog_core_api::feed_publisher::LoginFeeds;
    use mixdog_core_api::mock::FeedTap;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;

    let golden = fixture_at("login-status/golden.json");
    for case in golden["provider"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let start = &case["start"];
        let shown = if let Some(code) = start["userCode"].as_str() {
            LoginState::DeviceCode { user_code: code.to_owned(), verification_uri: start["url"].as_str().unwrap().to_owned(), expires_at: None }
        } else {
            LoginState::Authorize {
                url: start["url"].as_str().unwrap().to_owned(),
                manual_url: start["manualUrl"].as_str().map(str::to_owned),
            }
        };
        let steps = case["steps"].as_array().unwrap();
        let settled: Result<bool, String> = match (steps[0]["do"].as_str().unwrap(), &steps[0]["result"], steps[0]["message"].as_str()) {
            ("reject", _, Some(message)) => Err(message.to_owned()),
            ("callback", result, _) => Ok(result == &Value::Bool(true)),
            _ => Ok(true),
        };
        let settle = |outcome: Result<bool, String>| -> super::flows::Settle { Box::new(move |_| Box::pin(async move { outcome })) };
        let ttl = if name == "expired" {
            std::time::Duration::from_millis(1)
        } else {
            std::time::Duration::from_millis(super::flows::DEFAULT_FLOW_TTL_MS)
        };
        let scoped = std::sync::Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let flows = super::flows::OAuthFlows::new(ttl, std::sync::Arc::new(LoginFeeds::new(scoped.clone())));
        let session = LiveLoginSession::new(shown);
        let started = flows.register("openai-oauth", Box::new(session.clone()), settle(settled.clone())).unwrap();
        let flow_id = started["flowId"].as_str().unwrap().to_owned();
        let masked = |value: &Value| -> Value { serde_json::from_str(&value.to_string().replace(&flow_id, "<flow>")).unwrap() };
        assert_eq!(masked(&started), case["started"], "{name}: the register answer");

        let feed_id = scoped.ids().into_iter().find(|id| id.0 == format!("login:{flow_id}")).unwrap();
        let tap = FeedTap::attach(&scoped.find(&feed_id).unwrap());
        for (index, step) in steps.iter().enumerate() {
            match step["do"].as_str().unwrap() {
                "callback" | "reject" => session.emit(LoginState::Done { account: None }),
                "cancel" => {
                    flows.cancel(&flow_id).await.unwrap();
                }
                "supersede" => {
                    flows
                        .register("openai-oauth", Box::new(LiveLoginSession::new(LoginState::Starting)), settle(Ok(true)))
                        .unwrap();
                }
                "code" => {
                    flows.complete(&flow_id, step["code"].as_str().unwrap()).await.unwrap();
                }
                // The flow's lifetime runs out by itself.
                "expire" => {}
                other => panic!("{name}: unknown step {other}"),
            }
            let seen = tap.notifications_until(|frames| frames.len() > index + 1).await;
            assert_eq!(seen[0]["method"], "feed/snapshot", "{name}");
            assert_eq!(masked(&seen[0]["params"]["state"]), case["started"], "{name}: the snapshot is the status the flow started with");
            assert_eq!(seen[index + 1]["method"], "login/updated", "{name} step {index}");
            assert_eq!(seen[index + 1]["params"]["flowId"], flow_id.as_str(), "{name}");
            assert_eq!(masked(&seen[index + 1]["params"]["state"]), case["statuses"][index], "{name} step {index}");
        }
        let late = FeedTap::attach(&scoped.find(&feed_id).unwrap());
        let seen = late.notifications_until(|frames| !frames.is_empty()).await;
        assert_eq!(masked(&seen[0]["params"]["state"]), *case["statuses"].as_array().unwrap().last().unwrap(), "{name}: a late subscriber");
        flows.cancel_all();
    }
}