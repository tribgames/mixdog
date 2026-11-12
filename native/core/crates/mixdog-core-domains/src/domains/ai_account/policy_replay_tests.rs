//! Replay of `native/core/fixtures/provider-accounts-policy-cases` (Node `shared/provider-accounts-policy.test.mjs`
//! at b6f10295a): the roster file an older build wrote read back through [`AccountStore::pool`], the policy and
//! `auto` writes of `updateProviderAccounts` ([`parse_account_change`] then [`AccountStore::change`], the write
//! `update_provider_accounts` makes), and the pure picks and limits of `accounts::policy` on the recorded pools.
#![allow(clippy::disallowed_methods, reason = "the recording edits the roster file as an older build wrote it")]

use std::collections::HashSet;

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::accounts::Pool;
use mixdog_ai::accounts::policy::Limit;
use mixdog_ai::accounts::policy::account_exhausted_for_model_only;
use mixdog_ai::accounts::policy::account_limit;
use mixdog_ai::accounts::policy::choose_account;
use mixdog_ai::oauth::CredentialIo;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::admin::parse_account_change;
use super::failure::Failure;

const GOLDEN: mixdog_testkit::Fixture =
    mixdog_testkit::fixture_const!("../../fixtures/provider-accounts-policy-cases/golden.json");
const PROVIDER: &str = "openai-oauth";
/// The registered account's id; the recording writes Node's random one as `<account-1>`.
const ACCOUNT: &str = "00000000-0000-4000-8000-000000000001";

fn cases() -> Vec<(String, Exact)> {
    let golden: Value = serde_json::from_str(&GOLDEN).expect("golden parses");
    let decoded = Exact::decode(&golden).expect("golden decodes");
    decoded
        .get("cases")
        .as_array()
        .iter()
        .map(|case| (case.get("case").as_str().to_owned(), case.get("observed").clone()))
        .collect()
}

fn store(dir: &tempfile::TempDir) -> AccountStore {
    let tokens = mixdog_rt::testing::tokens();
    AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io })
}

/// `<account-1>` for the registered id, at the listed paths only (`normalised.paths`).
fn named(text: &str) -> Value {
    json!(text.replace(ACCOUNT, "<account-1>"))
}

/// The pool view: the account ids and `selectedId` carry the placeholder (manifest `normalised.paths`).
fn pool_view(pool: &Pool) -> Value {
    let mut value = serde_json::to_value(pool).expect("pool serializes");
    if let Some(rows) = value["accounts"].as_array_mut() {
        for row in rows {
            row["id"] = named(row["id"].as_str().unwrap_or_default());
        }
    }
    if let Some(selected) = value["selectedId"].as_str().map(named) {
        value["selectedId"] = selected;
    }
    value
}

fn rewrite(dir: &tempfile::TempDir, edit: impl FnOnce(&mut serde_json::Map<String, Value>)) {
    let path = dir.path().join("provider-accounts.json");
    let mut raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    edit(raw["providers"][PROVIDER].as_object_mut().unwrap());
    // `JSON.stringify(raw)`: compact.
    std::fs::write(&path, serde_json::to_string(&raw).unwrap()).unwrap();
}

fn failure(error: &Failure) -> Exact {
    let name = match error {
        Failure::Type(_) => "TypeError",
        _ => "Error",
    };
    Exact::Error { name: name.into(), message: error.message().into(), code: None, cause: None, props: vec![] }
}

fn object(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn limit_view(limit: Option<Limit>) -> Value {
    match limit {
        None => Value::Null,
        Some(Limit::Account) => json!({ "scope": "account" }),
        Some(Limit::Model(families)) => json!({ "scope": "model", "families": families }),
    }
}

#[tokio::test]
async fn every_recorded_roster_policy_case_answers_as_node() {
    let cases = cases();
    assert_eq!(cases.len(), 4);
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);

    // Case 0: the file as a build before switching policies wrote it.
    let (name, recorded) = &cases[0];
    store.register(PROVIDER, ACCOUNT, "", false).await.unwrap();
    let mut log = Vec::new();
    rewrite(&dir, |pool| {
        pool.remove("policy");
        pool.insert("auto".into(), json!(false));
    });
    log.push(json!({ "step": "file: no policy, auto false", "read": pool_view(&store.pool(PROVIDER).await.unwrap()) }));
    rewrite(&dir, |pool| {
        pool.insert("auto".into(), json!(true));
    });
    log.push(json!({ "step": "file: no policy, auto true", "read": pool_view(&store.pool(PROVIDER).await.unwrap()) }));
    rewrite(&dir, |pool| {
        pool.insert("policy".into(), json!("headroom"));
        pool.insert("auto".into(), json!(false));
    });
    log.push(json!({
        "step": "file: policy headroom, auto false (an older build turned switching off)",
        "read": pool_view(&store.pool(PROVIDER).await.unwrap()),
    }));
    assert_eq!(&Exact::plain(&json!({ "provider": PROVIDER, "log": log })), recorded, "{name}");

    // Case 1: policy and auto writes through updateProviderAccounts' parse and write.
    let (name, recorded) = &cases[1];
    let mut log = Vec::new();
    for change in [json!({ "policy": "headroom" }), json!({ "auto": true }), json!({ "auto": false }), json!({ "auto": true }), json!({ "policy": "manual" })] {
        let parsed = parse_account_change(&change).expect("a valid change");
        let pool = store.change(PROVIDER, parsed).await.unwrap();
        let file = std::fs::read_to_string(dir.path().join("provider-accounts.json")).unwrap();
        log.push(Exact::plain(&json!({ "change": change, "pool": pool_view(&pool), "file": named(&file) })));
    }
    let refused = parse_account_change(&json!({ "policy": "fastest" })).expect_err("an unknown policy is refused");
    log.push(object(vec![("change", Exact::plain(&json!({ "policy": "fastest" }))), ("rejected", failure(&refused))]));
    assert_eq!(&object(vec![("provider", Exact::String(PROVIDER.into())), ("log", Exact::Array(log))]), recorded, "{name}");

    // Case 2: the account each policy picks, on the recorded pools.
    let (name, recorded) = &cases[2];
    let model = recorded.get("model").as_str();
    let mut picks = Vec::new();
    for pick in recorded.get("picks").as_array() {
        let pool_value = pick.get("pool").to_plain().unwrap();
        let pool: Pool = serde_json::from_value(pool_value.clone()).unwrap();
        let used: HashSet<String> = pick.get("usedUp").as_array().iter().map(|id| id.as_str().to_owned()).collect();
        let options = pick.get("options");
        let session = match options {
            Exact::Undefined => None,
            other => Some(other.get("sessionAccountId").as_str()),
        };
        let now = pick.get("now").as_f64() as i64;
        let chosen = choose_account(&pool, &used, now, model, session);
        // The pick is one of the given rows (Node returns the same object): shown as that row.
        let picked = chosen.map_or(Exact::Null, |row| {
            let at = pool.accounts.iter().position(|r| std::ptr::eq(r, row)).unwrap();
            Exact::plain(&pool_value["accounts"][at])
        });
        picks.push(object(vec![
            ("label", pick.get("label").clone()),
            ("pool", Exact::plain(&pool_value)),
            ("usedUp", pick.get("usedUp").clone()),
            ("options", options.clone()),
            ("now", Exact::from(now as f64)),
            ("picked", picked),
        ]));
    }
    let observed = object(vec![("model", Exact::String(model.into())), ("now", recorded.get("now").clone()), ("picks", Exact::Array(picks))]);
    assert_eq!(&observed, recorded, "{name}");

    // Case 3: the family-scoped limit.
    let (name, recorded) = &cases[3];
    let now = recorded.get("now").as_f64() as i64;
    let rows: Vec<Value> = recorded.get("limits").as_array().iter().map(|l| l.get("account").to_plain().unwrap()).collect();
    let limits: Vec<Value> = rows
        .iter()
        .map(|raw| {
            let account = serde_json::from_value(raw.clone()).unwrap();
            json!({ "account": raw, "limit": limit_view(account_limit(&account, now, false)) })
        })
        .collect();
    let exhausted: Vec<Value> = [(0, "claude-fable-5"), (0, "claude-opus-4"), (1, "claude-fable-5")]
        .into_iter()
        .map(|(at, model)| {
            let account = serde_json::from_value(rows[at].clone()).unwrap();
            json!({ "accountId": rows[at]["id"], "model": model, "answer": account_exhausted_for_model_only(&account, now, model, false) })
        })
        .collect();
    let observed = Exact::plain(&json!({ "now": now, "limits": limits, "exhaustedForModelOnly": exhausted }));
    assert_eq!(&observed, recorded, "{name}");
}
