use std::collections::HashMap;
use std::collections::VecDeque;

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use tokio_util::sync::CancellationToken;

use super::rotation::*;
use super::*;
use crate::oauth::pace::FakePace;

const ID_A: &str = "11111111-1111-4111-8111-111111111111";
const ID_B: &str = "22222222-2222-4222-8222-222222222222";
const PROVIDER: &str = "grok-oauth";

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

fn refusal(kind: ErrorKind, status: u16) -> Failed {
    let mut error = ProviderError::new(kind, DeliveryState::Accepted);
    error.status = Some(status);
    Failed::new(error)
}

struct Script {
    by_account: Mutex<HashMap<String, VecDeque<Result<&'static str, Failed>>>>,
    calls: Mutex<Vec<String>>,
    stages: Mutex<Vec<Stage>>,
    cooldown: Option<CooldownPolicy>,
}

impl Script {
    fn new(script: Vec<(&str, Vec<Result<&'static str, Failed>>)>) -> Self {
        Self {
            by_account: Mutex::new(script.into_iter().map(|(id, replies)| (id.to_owned(), replies.into())).collect()),
            calls: Mutex::default(),
            stages: Mutex::default(),
            cooldown: None,
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl AccountSender<String> for Script {
    fn cooldown_policy(&self, _: &str) -> Option<CooldownPolicy> {
        self.cooldown.clone()
    }

    async fn send(&self, account_id: &str, _scoped: bool) -> Result<String, Failed> {
        self.calls.lock().unwrap().push(account_id.to_owned());
        let reply = self.by_account.lock().unwrap().get_mut(account_id).and_then(VecDeque::pop_front);
        reply.expect("a scripted reply").map(str::to_owned)
    }

    fn stamp(&self, result: &mut String, account_id: &str, binding_id: &str) {
        result.push_str(&format!("@{}/{}", &account_id[..2], &binding_id[..2]));
    }

    fn notify(&self, stage: Stage) {
        self.stages.lock().unwrap().push(stage);
    }
}

struct NoProbe;

#[async_trait]
impl UsageProbe for NoProbe {
    async fn measure(&self, _: &str, _: &str, _: bool) {}
}

/// A manual clock at a realistic wall time.
fn clock() -> Arc<FakePace> {
    Arc::new(FakePace { now: std::sync::atomic::AtomicU64::new(1_800_000_000_000), ..FakePace::default() })
}

async fn rotation(dir: &tempfile::TempDir, pace: Arc<FakePace>) -> (AccountRotation, AccountStore) {
    let s = store(dir);
    s.register(PROVIDER, ID_A, "A", false).await.unwrap();
    s.register(PROVIDER, ID_B, "B", false).await.unwrap();
    (AccountRotation::new(s.clone(), Arc::new(NoProbe), pace), s)
}

fn ctx() -> SendContext {
    SendContext {
        model: "grok-4".into(),
        session_id: None,
        bound_hint: None,
        cancel: CancellationToken::new(),
        implicit_plan_usage: None,
    }
}

#[tokio::test]
async fn a_quota_refusal_blocks_the_account_rotates_and_commits_the_fallback() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, s) = rotation(&dir, clock()).await;
    let script = Script::new(vec![
        (ID_A, vec![Err(refusal(ErrorKind::QuotaExhausted, 429))]),
        (ID_B, vec![Ok("answer")]),
    ]);
    let got = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap();
    assert_eq!(got, "answer@22/22");
    assert_eq!(script.calls(), [ID_A, ID_B]);
    let pool = s.pool(PROVIDER).await.unwrap();
    let a = pool.account(ID_A).unwrap();
    assert_eq!(a.blocked_quota, Some(true), "a typed quota refusal is quota evidence");
    assert_eq!(pool.selected_id.as_deref(), Some(ID_B), "the fallback that answered becomes the account of record");
    let stages = script.stages.lock().unwrap();
    assert!(stages.iter().any(|s| matches!(s, Stage::AccountChanged { account_id, .. } if account_id == ID_B)));
    assert!(stages.iter().any(|s| matches!(s, Stage::Reconnecting { message, .. } if message.starts_with("Quota exhausted"))));
}

#[tokio::test]
async fn every_account_spent_proves_quota_exhaustion_with_the_last_error() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, _) = rotation(&dir, clock()).await;
    let script = Script::new(vec![
        (ID_A, vec![Err(refusal(ErrorKind::QuotaExhausted, 429))]),
        (ID_B, vec![Err(refusal(ErrorKind::Billing, 402))]),
    ]);
    let err = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap_err();
    assert!(matches!(&err.cause, Cause::Provider(e) if e.kind == ErrorKind::Billing));
    let proof = err.quota_exhausted.expect("quota proof");
    assert_eq!((proof.provider.as_str(), proof.model.as_str()), (PROVIDER, "grok-4"));
}

#[tokio::test]
async fn server_side_failures_and_auth_refusals_never_block_or_rotate() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, s) = rotation(&dir, clock()).await;
    for failed in [refusal(ErrorKind::Overloaded, 529), refusal(ErrorKind::QuotaExhausted, 403)] {
        let script = Script::new(vec![(ID_A, vec![Err(failed)])]);
        let err = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap_err();
        assert!(matches!(err.cause, Cause::Provider(_)) && err.quota_exhausted.is_none());
        assert_eq!(script.calls(), [ID_A]);
    }
    assert!(s.pool(PROVIDER).await.unwrap().accounts.iter().all(|a| a.blocks().is_empty()));
}

#[tokio::test]
async fn manual_policy_serves_the_selected_account_only() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, s) = rotation(&dir, clock()).await;
    s.change(PROVIDER, AccountChange { policy: Some(Policy::Manual), ..AccountChange::default() }).await.unwrap();
    let script = Script::new(vec![(ID_A, vec![Err(refusal(ErrorKind::QuotaExhausted, 429))])]);
    let err = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap_err();
    assert!(err.quota_exhausted.is_some());
    assert_eq!(script.calls(), [ID_A], "B is never tried");
}

/// A manual clock: the stored cooldown and the wait read it, and the wait
/// moves it, so the cooldown ends exactly when the wait does, with no real time.
#[tokio::test]
async fn a_cooldown_only_roster_waits_within_the_policy_bound_then_retries() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    s.register(PROVIDER, ID_A, "A", false).await.unwrap();
    let pace = clock();
    let rotation = AccountRotation::new(s, Arc::new(NoProbe), pace.clone());
    let started = pace.now_ms();
    let mut script = Script::new(vec![(
        ID_A,
        vec![Err(refusal(ErrorKind::RateLimited, 429)), Ok("late")],
    )]);
    script.cooldown = Some(CooldownPolicy {
        rotate_on_rate_limit: true,
        rate_limited_ms: Some(40),
        wait_for_cooldown_ms: Some(10_000),
        ..CooldownPolicy::default()
    });
    assert_eq!(rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap(), "late@11/11");
    assert_eq!(script.calls(), [ID_A, ID_A]);
    let waits: Vec<i64> = script
        .stages
        .lock()
        .unwrap()
        .iter()
        .filter_map(|s| if let Stage::Reconnecting { wait_ms: Some(w), .. } = s { Some(*w) } else { None })
        .collect();
    assert_eq!(waits, [40], "waited once, for the cooldown");
    assert_eq!(pace.now_ms() - started, 40);
    assert_eq!(*pace.waits.lock().unwrap(), [std::time::Duration::from_millis(40)]);
}

#[tokio::test]
async fn without_a_wait_policy_a_cooldown_surfaces_the_provider_error() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, _) = rotation(&dir, clock()).await;
    let mut script = Script::new(vec![
        (ID_A, vec![Err(refusal(ErrorKind::RateLimited, 429))]),
        (ID_B, vec![Err(refusal(ErrorKind::RateLimited, 429))]),
    ]);
    script.cooldown = Some(CooldownPolicy { rotate_on_rate_limit: true, ..CooldownPolicy::default() });
    let err = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap_err();
    assert!(matches!(err.cause, Cause::Provider(_)));
    assert!(err.quota_exhausted.is_none(), "a cooldown is not quota evidence");
}

#[tokio::test]
async fn output_already_emitted_is_never_re_sent_to_another_account() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, _) = rotation(&dir, clock()).await;
    let mut failed = refusal(ErrorKind::QuotaExhausted, 429);
    failed.emitted = true;
    let script = Script::new(vec![(ID_A, vec![Err(failed)])]);
    let err = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap_err();
    assert!(matches!(err.cause, Cause::Provider(_)));
    assert_eq!(script.calls(), [ID_A]);
}

#[tokio::test]
async fn a_provider_without_a_roster_sends_unscoped() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let rotation = AccountRotation::new(store(&dir), Arc::new(NoProbe), clock());
    let script = Script::new(vec![("default", vec![Ok("plain")])]);
    assert_eq!(rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap(), "plain");
}
