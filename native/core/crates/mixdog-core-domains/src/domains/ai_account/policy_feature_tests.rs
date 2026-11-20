//! The account roster policy: how an older roster file reads, what a policy or `auto` change writes, what is refused, and
//! which account each policy picks.
#![allow(clippy::disallowed_methods, reason = "the test edits the roster file as an older build wrote it")]

use std::collections::HashSet;

use mixdog_ai::accounts::policy::{Limit, account_exhausted_for_model_only, account_limit, choose_account};
use mixdog_ai::accounts::{AccountStore, Pool};
use mixdog_ai::oauth::CredentialIo;
use serde_json::{Value, json};

use super::admin::parse_account_change;

const PROVIDER: &str = "openai-oauth";
const ACCOUNT: &str = "00000000-0000-4000-8000-000000000001";

fn store(dir: &tempfile::TempDir) -> AccountStore {
    let tokens = mixdog_rt::testing::tokens();
    AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io })
}

fn rewrite(dir: &tempfile::TempDir, edit: impl FnOnce(&mut serde_json::Map<String, Value>)) {
    let path = dir.path().join("provider-accounts.json");
    let mut raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    edit(raw["providers"][PROVIDER].as_object_mut().unwrap());
    std::fs::write(&path, serde_json::to_string(&raw).unwrap()).unwrap();
}

async fn read(store: &AccountStore) -> (Value, Value) {
    let pool = serde_json::to_value(store.pool(PROVIDER).await.unwrap()).unwrap();
    (pool["auto"].clone(), pool["policy"].clone())
}

#[tokio::test]
async fn a_roster_saved_before_switching_policies_maps_auto_onto_a_policy() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    store.register(PROVIDER, ACCOUNT, "", false).await.unwrap();
    rewrite(&dir, |pool| {
        pool.remove("policy");
        pool.insert("auto".into(), json!(false));
    });
    assert_eq!(read(&store).await, (json!(false), json!("manual")));
    rewrite(&dir, |pool| {
        pool.insert("auto".into(), json!(true));
    });
    assert_eq!(read(&store).await, (json!(true), json!("limit")));
    rewrite(&dir, |pool| {
        pool.insert("policy".into(), json!("headroom"));
        pool.insert("auto".into(), json!(false));
    });
    assert_eq!(read(&store).await, (json!(false), json!("manual")), "an older build turned switching off: the policy does not outlive it");
}

#[tokio::test]
async fn a_policy_or_auto_change_keeps_the_other_readable_for_builds_that_predate_policies() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    store.register(PROVIDER, ACCOUNT, "", false).await.unwrap();
    let mut seen = Vec::new();
    for change in [json!({ "policy": "headroom" }), json!({ "auto": true }), json!({ "auto": false }), json!({ "auto": true }), json!({ "policy": "manual" })] {
        let pool = serde_json::to_value(store.change(PROVIDER, parse_account_change(&change).unwrap()).await.unwrap()).unwrap();
        let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("provider-accounts.json")).unwrap()).unwrap();
        assert_eq!(file["providers"][PROVIDER]["auto"], pool["auto"], "{change}: the file keeps auto for older builds");
        assert_eq!(file["providers"][PROVIDER]["policy"], pool["policy"], "{change}");
        seen.push((pool["auto"].clone(), pool["policy"].clone()));
    }
    assert_eq!(
        seen,
        [
            (json!(true), json!("headroom")),
            (json!(true), json!("headroom")),
            (json!(false), json!("manual")),
            (json!(true), json!("limit")),
            (json!(false), json!("manual"))
        ]
    );
}

#[test]
fn an_account_change_names_what_it_refuses() {
    for (change, want) in [
        (json!({ "policy": "fastest" }), "Unknown account switching policy."),
        (json!({ "auto": "yes" }), "Automatic account switching must be boolean."),
        (json!({ "useCredits": 1 }), "Credit use must be boolean."),
        (json!({ "order": "a" }), "Account order must contain every connected account exactly once."),
        (json!({ "rename": { "id": "a", "label": "  " } }), "Invalid account name."),
        (json!({ "rename": { "id": "a", "label": "x".repeat(81) } }), "Invalid account name."),
        (json!({ "unknown": 1 }), "Invalid provider account change."),
        (json!("text"), "Invalid provider account change."),
    ] {
        let refused = parse_account_change(&change).err().unwrap_or_else(|| panic!("{change} was accepted"));
        assert_eq!(refused.message(), want, "{change}");
    }
    assert!(parse_account_change(&json!({ "policy": "headroom", "auto": true, "useCredits": false })).is_ok());
}

fn pool(extra: Value) -> Pool {
    let mut value = json!({
        "accounts": [
            { "id": "a", "usage": { "windows": [{ "label": "5H", "usedPct": 60 }], "checkedAt": 5_000_000 } },
            { "id": "b", "usage": { "windows": [{ "label": "5H", "usedPct": 10 }], "checkedAt": 5_000_000 } },
            { "id": "c", "usage": { "windows": [{ "label": "5H", "usedPct": 30 }], "checkedAt": 5_000_000 } },
        ],
        "selectedId": "a",
    });
    value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(value).unwrap()
}

fn picked(pool: &Pool, used_up: &[&str], session: Option<&str>) -> Option<String> {
    let used: HashSet<String> = used_up.iter().map(|id| (*id).to_owned()).collect();
    choose_account(pool, &used, 5_000_000, "m", session).map(|row| row.id.clone())
}

#[test]
fn a_manual_roster_keeps_the_selected_account_and_does_not_move_when_it_is_used_up() {
    let manual = pool(json!({ "auto": false }));
    assert_eq!(picked(&manual, &[], None).as_deref(), Some("a"));
    assert_eq!(picked(&manual, &["a"], None), None);
}

#[test]
fn the_limit_policy_stays_on_the_selected_account_until_it_is_used_up() {
    let limit = pool(json!({ "auto": true }));
    assert_eq!(picked(&limit, &[], None).as_deref(), Some("a"));
    assert_ne!(picked(&limit, &["a"], None).as_deref(), Some("a"));
    assert!(picked(&limit, &["a"], None).is_some(), "another account takes over");
}

#[test]
fn the_headroom_policy_picks_the_account_with_the_most_room_for_a_first_request() {
    let headroom = pool(json!({ "auto": true, "policy": "headroom" }));
    assert_eq!(picked(&headroom, &[], None).as_deref(), Some("b"));
}

fn row(value: Value) -> mixdog_ai::accounts::Account {
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_full_model_family_window_limits_that_family_only_and_a_full_five_hour_window_limits_the_account() {
    const NOW: i64 = 5_000_000;
    let family_full = row(
        json!({ "id": "a", "usage": { "windows": [{ "label": "5H", "usedPct": 12, "resetAt": 5_001_000 }, { "label": "7D Fable", "usedPct": 100, "resetAt": 5_001_000 }], "checkedAt": NOW } }),
    );
    let everything_full = row(
        json!({ "id": "b", "usage": { "windows": [{ "label": "5H", "usedPct": 100, "resetAt": 5_001_000 }, { "label": "7D Fable", "usedPct": 100, "resetAt": 5_001_000 }], "checkedAt": NOW } }),
    );
    let blocked_family = row(
        json!({ "id": "c", "usage": { "windows": [{ "label": "7D Fable", "usedPct": 40 }], "checkedAt": NOW }, "blockedUntil": 5_001_000, "blockedModel": "claude-fable-5" }),
    );
    let blocked_other_model = row(json!({ "id": "d", "blockedUntil": 5_001_000, "blockedModel": "gpt-5" }));
    let nearly_full = row(json!({ "id": "e", "usage": { "windows": [{ "label": "7D", "usedPct": 99 }], "checkedAt": NOW } }));

    assert_eq!(account_limit(&family_full, NOW, false), Some(Limit::Model(vec!["Fable".to_owned()])));
    assert_eq!(account_limit(&everything_full, NOW, false), Some(Limit::Account));
    assert_eq!(account_limit(&blocked_family, NOW, false), Some(Limit::Model(vec!["Fable".to_owned()])));
    assert_eq!(account_limit(&blocked_other_model, NOW, false), Some(Limit::Account));
    assert_eq!(account_limit(&nearly_full, NOW, false), None);

    assert!(account_exhausted_for_model_only(&family_full, NOW, "claude-fable-5", false));
    assert!(!account_exhausted_for_model_only(&family_full, NOW, "claude-opus-4", false), "another family is still open");
    assert!(
        !account_exhausted_for_model_only(&everything_full, NOW, "claude-fable-5", false),
        "an account that is full everywhere is not limited for one model only"
    );
}
