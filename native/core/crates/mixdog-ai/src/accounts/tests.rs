#![allow(clippy::disallowed_methods, reason = "fixtures are written and read directly")]

use super::*;

const ID_A: &str = "11111111-1111-4111-8111-111111111111";
const ID_B: &str = "22222222-2222-4222-8222-222222222222";
const PROVIDER: &str = "command-code-oauth";

fn store(dir: &tempfile::TempDir) -> AccountStore {
    let tokens = mixdog_rt::testing::tokens();
    AccountStore::new(
        dir.path().to_path_buf(),
        CredentialIo {
            read: tokens.interactive_io,
            write: tokens.durability_io,
        },
    )
}

#[tokio::test]
async fn an_unregistered_provider_has_no_accounts_and_no_credential() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    assert!(s.accounts(PROVIDER).await.unwrap().is_empty());
    assert!(!s.has_credential(PROVIDER, "default").await.unwrap());
    assert!(matches!(s.pool("nope").await, Err(AccountError::Invalid(_))));
    assert!(!s.roster_path().exists(), "reading writes nothing");
}

#[tokio::test]
async fn register_labels_selects_first_and_keeps_the_previous_roster_as_bak() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    let pool = s.register(PROVIDER, ID_A, "", true).await.unwrap();
    let ids: Vec<_> = pool.accounts.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["default", ID_A]);
    assert_eq!(pool.accounts[0].label.as_deref(), Some("Account 1"));
    assert_eq!(pool.accounts[1].label.as_deref(), Some("Account 2"));
    assert_eq!(pool.selected_id.as_deref(), Some("default"));
    assert!(!dir.path().join("provider-accounts.json.bak").exists());
    s.register(PROVIDER, ID_B, "Work", false).await.unwrap();
    assert!(dir.path().join("provider-accounts.json.bak").exists());
    assert_eq!(s.accounts(PROVIDER).await.unwrap().len(), 3);
}

#[tokio::test]
async fn has_credential_reads_the_slots_file() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    std::fs::write(dir.path().join("command-code-oauth.json"), r#"{"access_token":"t"}"#).unwrap();
    assert!(s.has_credential(PROVIDER, "default").await.unwrap());
    assert!(!s.has_credential(PROVIDER, ID_A).await.unwrap());
    let path = s.account_path(PROVIDER, ID_A).unwrap().unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{}").unwrap();
    assert!(!s.has_credential(PROVIDER, ID_A).await.unwrap(), "an empty document is logged out");
    std::fs::write(&path, "{ not json").unwrap();
    assert!(s.has_credential(PROVIDER, ID_A).await.unwrap(), "unreadable is never a logout");
}

#[tokio::test]
async fn change_validates_and_select_if_loses_to_a_newer_selection() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.register(PROVIDER, ID_A, "A", true).await.unwrap();
    s.register(PROVIDER, ID_B, "B", false).await.unwrap();
    let ordered = s
        .change(
            PROVIDER,
            AccountChange {
                order: Some(vec![ID_B.into(), "default".into(), ID_A.into()]),
                selected_id: Some(ID_B.into()),
                policy: Some(Policy::Headroom),
                ..AccountChange::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(ordered.accounts[0].id, ID_B);
    assert_eq!((ordered.policy(), ordered.auto), (Policy::Headroom, Some(true)));
    let bad = s
        .change(PROVIDER, AccountChange { order: Some(vec![ID_B.into()]), ..AccountChange::default() })
        .await;
    assert!(matches!(bad, Err(AccountError::Invalid(_))));
    let gone = s
        .change(PROVIDER, AccountChange { selected_id: Some("33333333-3333-4333-8333-333333333333".into()), ..AccountChange::default() })
        .await;
    assert!(matches!(gone, Err(AccountError::Rejected(_))));
    assert!(s.select_if(PROVIDER, Some("default"), ID_A, None).await.unwrap().is_none(), "selection is B, not default");
    let moved = s.select_if(PROVIDER, Some(ID_B), ID_A, Some(Policy::Headroom)).await.unwrap().unwrap();
    assert_eq!(moved.selected_id.as_deref(), Some(ID_A));
    let off = s.change(PROVIDER, AccountChange { auto: Some(false), ..AccountChange::default() }).await.unwrap();
    assert_eq!(off.policy(), Policy::Manual);
    let on = s.change(PROVIDER, AccountChange { auto: Some(true), ..AccountChange::default() }).await.unwrap();
    assert_eq!(on.policy(), Policy::Limit, "on from manual is switch-at-limit");
    let removed = s.remove(PROVIDER, ID_A).await.unwrap();
    assert_eq!(removed.selected_id.as_deref(), Some(ID_B), "selection falls to the first remaining");
}

#[tokio::test]
async fn a_selection_move_calls_the_hook_and_other_writes_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = calls.clone();
    let s = store(&dir).on_selection_change(move || {
        seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    s.register(PROVIDER, ID_A, "A", false).await.unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "first registration selects");
    s.block(PROVIDER, ID_A, s.now_ms() + 1000, "", BlockOptions::default()).await.unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn blocks_cap_replace_per_model_and_a_free_reading_lifts_them() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.register(PROVIDER, ID_A, "A", false).await.unwrap();
    let far = s.now_ms() + 3 * MAX_BLOCK_MS;
    let pool = s.block(PROVIDER, ID_A, far, "m1", BlockOptions::default()).await.unwrap();
    assert!(pool.accounts[0].blocked_until.unwrap() < far, "inferred blocks are capped");
    let pool = s
        .block(PROVIDER, ID_A, far, "", BlockOptions { reset: true, quota: true, server_scheduled: true, ..BlockOptions::default() })
        .await
        .unwrap();
    let blocks = pool.accounts[0].blocks();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[1].blocked_until, far, "a named reset is kept as given");
    let pool = s.block(PROVIDER, ID_A, far, "m1", BlockOptions::default()).await.unwrap();
    assert_eq!(pool.accounts[0].blocks().len(), 2, "same-model refusal replaces its own block");
    let free = |used| QuotaWindowInput { label: "5H".into(), used_pct: Some(used), ..QuotaWindowInput::default() };
    s.record_usage(PROVIDER, ID_A, vec![free(100.0)]).await.unwrap();
    assert_eq!(s.accounts(PROVIDER).await.unwrap()[0].blocks().len(), 2, "a full meter lifts nothing");
    s.record_usage(PROVIDER, ID_A, vec![free(10.0)]).await.unwrap();
    let row = &s.accounts(PROVIDER).await.unwrap()[0];
    assert!(row.blocks().is_empty());
    assert_eq!(row.usage.as_ref().unwrap().windows[0].used_pct, Some(10.0));
    s.clear_quota_state(PROVIDER, ID_A).await.unwrap();
    assert!(s.accounts(PROVIDER).await.unwrap()[0].usage.is_none());
}

#[tokio::test]
async fn a_damaged_roster_is_set_aside_and_the_last_good_copy_restored() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.register(PROVIDER, ID_A, "A", false).await.unwrap();
    s.register(PROVIDER, ID_B, "B", false).await.unwrap();
    std::fs::write(s.roster_path(), "{ truncated").unwrap();
    let accounts = s.accounts(PROVIDER).await.unwrap();
    assert_eq!(accounts.len(), 1, "the .bak holds the roster before the second write");
    let aside: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
        .collect();
    assert_eq!(aside.len(), 1);
    std::fs::write(s.roster_path(), "").unwrap();
    std::fs::remove_file(dir.path().join("provider-accounts.json.bak")).unwrap();
    assert!(s.accounts(PROVIDER).await.unwrap().is_empty(), "no good copy: start empty");
}

#[tokio::test]
async fn a_newer_builds_roster_is_never_overwritten_and_unknown_fields_survive() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    let newer = r#"{"version":2,"providers":{}}"#;
    std::fs::write(s.roster_path(), newer).unwrap();
    assert!(s.accounts(PROVIDER).await.unwrap().is_empty());
    assert!(matches!(s.register(PROVIDER, ID_A, "A", false).await, Err(AccountError::Unsupported(_))));
    assert_eq!(std::fs::read_to_string(s.roster_path()).unwrap(), newer);
    std::fs::write(
        s.roster_path(),
        format!(r#"{{"version":1,"providers":{{"future-oauth":{{"x":1}},"{PROVIDER}":{{"accounts":[{{"id":"default","extra":true}}],"selectedId":"default","note":"keep"}}}}}}"#),
    )
    .unwrap();
    s.register(PROVIDER, ID_A, "A", false).await.unwrap();
    let text = std::fs::read_to_string(s.roster_path()).unwrap();
    assert!(text.contains("future-oauth") && text.contains("\"extra\": true") && text.contains("\"note\": \"keep\""));
}

#[tokio::test]
async fn custom_provider_key_rosters_follow_the_ids_and_vanish_when_empty() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    assert_eq!(s.set_custom_key_ids("custom-x", vec![ID_A.into(), ID_B.into()]).await.unwrap(), [ID_A, ID_B]);
    let pool = s.pool("custom-x").await.unwrap();
    assert_eq!((pool.selected_id.as_deref(), pool.uses_credits()), (Some("default"), true));
    assert_eq!(s.set_custom_key_ids("custom-x", vec![ID_B.into()]).await.unwrap(), [ID_B]);
    assert!(s.set_custom_key_ids("custom-x", vec!["default".into()]).await.is_err());
    assert!(s.set_custom_key_ids(PROVIDER, vec![]).await.is_err(), "only custom providers");
    s.set_custom_key_ids("custom-x", vec![]).await.unwrap();
    assert!(s.accounts("custom-x").await.unwrap().is_empty());
}

#[test]
fn account_ids_are_uuids_or_default() {
    let id = new_account_id();
    assert!(valid_account_id(&id) && id.as_bytes()[14] == b'4');
    assert!(valid_account_id("default") && !valid_account_id("Default") && !valid_account_id("../x"));
}
