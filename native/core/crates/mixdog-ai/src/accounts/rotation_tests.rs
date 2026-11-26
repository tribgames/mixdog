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
    AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io })
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
        plan_meters_apply: true,
    }
}

#[tokio::test]
async fn a_quota_refusal_blocks_the_account_rotates_and_commits_the_fallback() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, s) = rotation(&dir, clock()).await;
    let script = Script::new(vec![(ID_A, vec![Err(refusal(ErrorKind::QuotaExhausted, 429))]), (ID_B, vec![Ok("answer")])]);
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
    let script = Script::new(vec![(ID_A, vec![Err(refusal(ErrorKind::QuotaExhausted, 429))]), (ID_B, vec![Err(refusal(ErrorKind::Billing, 402))])]);
    let err = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap_err();
    assert!(matches!(&err.cause, Cause::Provider(e) if e.kind == ErrorKind::Billing));
    let proof = err.quota_exhausted.expect("quota proof");
    assert_eq!((proof.provider.as_str(), proof.model.as_str()), (PROVIDER, "grok-4"));
}

#[tokio::test]
async fn refusals_that_are_not_about_usage_never_block_or_rotate() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, s) = rotation(&dir, clock()).await;
    let mut expired = refusal(ErrorKind::Auth, 401);
    expired.error.reauth_required = true;
    // The meters of this account show no spent window: a long advised wait alone is not the quota.
    let mut long_wait = refusal(ErrorKind::RateLimited, 429);
    long_wait.error.retry_after = Some(std::time::Duration::from_secs(600));
    for failed in [refusal(ErrorKind::Overloaded, 529), refusal(ErrorKind::QuotaExhausted, 403), expired, long_wait] {
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
    let mut script = Script::new(vec![(ID_A, vec![Err(refusal(ErrorKind::RateLimited, 429)), Ok("late")])]);
    script.cooldown =
        Some(CooldownPolicy { rotate_on_rate_limit: true, rate_limited_ms: Some(40), wait_for_cooldown_ms: Some(10_000), ..CooldownPolicy::default() });
    assert_eq!(rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap(), "late@11/11");
    assert_eq!(script.calls(), [ID_A, ID_A]);
    let waits: Vec<i64> =
        script.stages.lock().unwrap().iter().filter_map(|s| if let Stage::Reconnecting { wait_ms: Some(w), .. } = s { Some(*w) } else { None }).collect();
    assert_eq!(waits, [40], "waited once, for the cooldown");
    assert_eq!(pace.now_ms() - started, 40);
    assert_eq!(*pace.waits.lock().unwrap(), [std::time::Duration::from_millis(40)]);
}

#[tokio::test]
async fn without_a_wait_policy_a_cooldown_surfaces_the_provider_error() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, _) = rotation(&dir, clock()).await;
    let mut script = Script::new(vec![(ID_A, vec![Err(refusal(ErrorKind::RateLimited, 429))]), (ID_B, vec![Err(refusal(ErrorKind::RateLimited, 429))])]);
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

fn implicit_reading(used_pct: f64, reset_at: Option<i64>, checked_at: i64) -> Account {
    let window = Window { label: "7D".into(), used_pct: Some(used_pct), reset_at, ..Window::default() };
    Account { usage: Some(Usage { windows: vec![window], checked_at }), ..Account::new("default") }
}

/// A provider with no roster is refused before the wire only on a reading that proves its window spent now; a stale
/// reading with no reset, a reading whose reset has passed and a recovered one all leave the send to go out.
#[tokio::test]
async fn a_provider_without_a_roster_is_refused_only_on_a_proven_spent_plan_window() {
    mixdog_rt::testing::tokens();
    let now = 1_800_000_000_000;
    let dir = tempfile::tempdir().unwrap();
    let rotation = AccountRotation::new(store(&dir), Arc::new(NoProbe), clock());

    let mut spent = ctx();
    spent.implicit_plan_usage = Some(implicit_reading(100.0, Some(now + 60_000), now - 1_000));
    let script = Script::new(vec![]);
    let err = rotation.pool_send(PROVIDER, &spent, &script).await.unwrap_err();
    assert_eq!(err.quota_exhausted.expect("quota proof").reset_at, Some(now + 60_000));
    assert!(script.calls().is_empty(), "no wire call for a proven exhaustion");

    for (used, reset, checked) in [(100.0, None, now - 24 * 60 * 60 * 1_000), (100.0, Some(now - 1), now - 1_000), (40.0, Some(now + 60_000), now - 1_000)] {
        let mut ordinary = ctx();
        ordinary.implicit_plan_usage = Some(implicit_reading(used, reset, checked));
        let script = Script::new(vec![("default", vec![Ok("plain")])]);
        assert_eq!(rotation.pool_send(PROVIDER, &ordinary, &script).await.unwrap(), "plain");
    }
}

/// The stored plan meters steer a roster as they do no roster: full meters refuse before the wire; a full percent that
/// states credit remaining does not (the percent is stored as observed); and where the meters were not proven for the
/// destination they steer nothing.
#[tokio::test]
async fn full_plan_meters_refuse_a_roster_only_where_they_apply_and_state_no_credit_left() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let (rotation, s) = rotation(&dir, clock()).await;
    let full = |remaining: Option<f64>| QuotaWindowInput {
        label: "7D".into(),
        used_pct: Some(100.0),
        reset_at: Some(1_900_000_000_000),
        remaining,
        ..QuotaWindowInput::default()
    };
    for id in [ID_A, ID_B] {
        s.record_usage(PROVIDER, id, vec![full(None)]).await.unwrap();
    }

    let script = Script::new(vec![]);
    let err = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap_err();
    assert_eq!(err.quota_exhausted.expect("proof").reset_at, Some(1_900_000_000_000));
    assert!(script.calls().is_empty(), "no wire call for proven exhaustion");

    let mut elsewhere = ctx();
    elsewhere.plan_meters_apply = false;
    let script = Script::new(vec![(ID_A, vec![Ok("sent")])]);
    assert!(rotation.pool_send(PROVIDER, &elsewhere, &script).await.unwrap().starts_with("sent"));

    for id in [ID_A, ID_B] {
        s.record_usage(PROVIDER, id, vec![full(Some(2.5))]).await.unwrap();
    }
    let script = Script::new(vec![(ID_A, vec![Ok("sent")])]);
    assert!(rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap().starts_with("sent"));
    let stored = s.pool(PROVIDER).await.unwrap();
    assert_eq!(stored.account(ID_A).unwrap().usage.as_ref().unwrap().windows[0].used_pct, Some(100.0));
}

/// A refusal is classified against the same service as admission: a full plan meter makes a plain 429 quota evidence
/// where the meters describe the destination, and says nothing where they do not. The full meter is the reading the
/// refusal itself takes: one stored before the send would keep the account from being chosen at all.
#[tokio::test]
async fn a_refusal_takes_quota_evidence_from_plan_meters_only_where_they_apply() {
    mixdog_rt::testing::tokens();
    for (applies, evidence) in [(true, Some(true)), (false, None)] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        s.register(PROVIDER, ID_A, "A", false).await.unwrap();
        s.register(PROVIDER, ID_B, "B", false).await.unwrap();
        let probe = Arc::new(FullReading { store: s.clone(), full: ID_A, measured: Mutex::default() });
        let rotation = AccountRotation::new(s.clone(), probe, clock());
        let mut send = ctx();
        send.plan_meters_apply = applies;
        let script = Script::new(vec![(ID_A, vec![Err(refusal(ErrorKind::RateLimited, 429))]), (ID_B, vec![Ok("answer")])]);
        let _ = rotation.pool_send(PROVIDER, &send, &script).await;
        let blocked = s.pool(PROVIDER).await.unwrap();
        assert_eq!(blocked.account(ID_A).unwrap().blocked_quota, evidence, "meters apply: {applies}");
    }
}

/// A probe whose reading of one account shows a full window; it keeps which accounts it was asked to measure.
struct FullReading {
    store: AccountStore,
    full: &'static str,
    measured: Mutex<Vec<String>>,
}

#[async_trait]
impl UsageProbe for FullReading {
    async fn measure(&self, provider: &str, account_id: &str, _force: bool) {
        self.measured.lock().unwrap().push(account_id.to_owned());
        let used_pct = if account_id == self.full { 100.0 } else { 10.0 };
        let window = QuotaWindowInput { label: "7D".into(), used_pct: Some(used_pct), reset_at: Some(1_900_000_000_000), ..QuotaWindowInput::default() };
        self.store.record_usage(provider, account_id, vec![window]).await.unwrap();
    }
}

#[tokio::test]
async fn a_fallback_is_chosen_on_readings_taken_as_the_pool_switches() {
    mixdog_rt::testing::tokens();
    const ID_C: &str = "33333333-3333-4333-8333-333333333333";
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    for (id, label) in [(ID_A, "A"), (ID_B, "B"), (ID_C, "C")] {
        s.register(PROVIDER, id, label, false).await.unwrap();
    }
    let probe = Arc::new(FullReading { store: s.clone(), full: ID_B, measured: Mutex::default() });
    let rotation = AccountRotation::new(s.clone(), probe.clone(), clock());
    let script = Script::new(vec![(ID_A, vec![Err(refusal(ErrorKind::QuotaExhausted, 429))]), (ID_C, vec![Ok("answer")])]);

    let got = rotation.pool_send(PROVIDER, &ctx(), &script).await.unwrap();

    // B was next in the roster, but the reading taken before the switch shows it full: no request is spent on it.
    assert_eq!(script.calls(), [ID_A, ID_C]);
    assert!(got.starts_with("answer@33"));
    let mut measured = probe.measured.lock().unwrap().clone();
    measured.retain(|id| id != ID_A);
    measured.sort();
    assert_eq!(measured, [ID_B, ID_C], "the accounts it could switch to are measured, once");
}

struct CreditReadingProbe {
    store: AccountStore,
    has_credits: Arc<std::sync::atomic::AtomicBool>,
    fail_probe: Arc<std::sync::atomic::AtomicBool>,
    reset_at: i64,
}

#[async_trait]
impl UsageProbe for CreditReadingProbe {
    async fn measure(&self, provider: &str, account_id: &str, force: bool) {
        let _ = self.measure_recorded(provider, account_id, force).await;
    }

    async fn measure_recorded(&self, provider: &str, account_id: &str, _force: bool) -> bool {
        if self.fail_probe.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        let window = QuotaWindowInput {
            label: "7D".into(),
            limit: Some("codex".into()),
            used_pct: Some(100.0),
            reset_at: Some(self.reset_at),
            ..QuotaWindowInput::default()
        };
        let has_credits = self.has_credits.load(std::sync::atomic::Ordering::SeqCst);
        self.store.record_usage_with_credits(provider, account_id, vec![window], Some(has_credits)).await.unwrap();
        true
    }
}

#[tokio::test]
async fn a_wire_quota_refusal_recorded_with_usable_credits_survives_next_turn_refreshes_and_resume_checks() {
    use crate::service::quota_usable::{AccountReading, Measurement, quota_measurement_serves_model};

    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    let pace = clock();
    let now = pace.now_ms() as i64;
    let reset_at = now + 18_000_000;
    s.register("openai-oauth", ID_A, "Default", false).await.unwrap();
    s.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let has_credits = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let fail_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let probe = Arc::new(CreditReadingProbe { store: s.clone(), has_credits: has_credits.clone(), fail_probe: fail_probe.clone(), reset_at });
    let rotation = AccountRotation::new(s.clone(), probe.clone(), pace.clone());
    let mut send_ctx = ctx();
    send_ctx.model = "gpt-6.2-astra".into();

    // Turn 1: server returns 429 QuotaExhausted even though readings already show usable credits.
    let mut quota_429 = refusal(ErrorKind::QuotaExhausted, 429);
    quota_429.error.reset_at = Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(reset_at as u64));
    let turn1 = Script::new(vec![(ID_A, vec![Err(quota_429)])]);
    let err = rotation.pool_send("openai-oauth", &send_ctx, &turn1).await.unwrap_err();
    assert!(err.quota_exhausted.is_some());
    assert_eq!(turn1.calls(), [ID_A]);
    let row = s.pool("openai-oauth").await.unwrap().account(ID_A).unwrap().clone();
    assert_eq!(row.blocked_with_credits, Some(true));

    // Turn 2: begin_loop resets probe pacing; the next send must not clear the block or hit the wire again.
    rotation.reset_probe_pacing();
    let turn2 = Script::new(vec![]);
    let err = rotation.pool_send("openai-oauth", &send_ctx, &turn2).await.unwrap_err();
    assert!(err.quota_exhausted.is_some());
    assert!(turn2.calls().is_empty(), "a wire refusal taken under usable credits must not be re-sent next turn");

    // Sidebar/statusline refresh with the same credit reading must keep the block.
    probe.measure("openai-oauth", ID_A, true).await;
    let pool = s.pool("openai-oauth").await.unwrap();
    assert!(policy::account_exhausted(pool.account(ID_A).unwrap(), now, "gpt-6.2-astra", true));

    // Quota-resume check must not wake a paused session into the same 429.
    let reading = serde_json::json!({
        "quotaWindows": [{ "label": "7D", "limit": "codex", "usedPct": 100.0, "resetAt": reset_at }],
        "balance": { "source": "openai-codex-credits", "hasCredits": true, "unlimited": false, "remainingCredits": 570.84 }
    });
    assert!(
        !quota_measurement_serves_model(
            &Measurement::Roster { use_credits: true, accounts: vec![AccountReading { id: ID_A, reading: Some(&reading) }], pool: &pool },
            "gpt-6.2-astra",
            now,
        ),
        "quota-resume must stay paused while the server's credit-mode block holds"
    );

    // Manual policy (`auto: false`) with `use_credits: true` must also honor `blocked_with_credits`.
    s.change("openai-oauth", AccountChange { auto: Some(false), ..AccountChange::default() }).await.unwrap();
    let manual_pool = s.pool("openai-oauth").await.unwrap();
    assert!(
        !quota_measurement_serves_model(
            &Measurement::Roster { use_credits: true, accounts: vec![AccountReading { id: ID_A, reading: Some(&reading) }], pool: &manual_pool },
            "gpt-6.2-astra",
            now,
        ),
        "manual policy must not wake paused session into a credit-mode block"
    );
    rotation.reset_probe_pacing();
    let manual_turn = Script::new(vec![]);
    assert!(rotation.pool_send("openai-oauth", &send_ctx, &manual_turn).await.is_err());
    assert!(manual_turn.calls().is_empty());
    s.change("openai-oauth", AccountChange { auto: Some(true), ..AccountChange::default() }).await.unwrap();

    // Contrast 1: if the refusal-time usage probe fails while stale `has_credits = Some(true)` is on disk,
    // `blocked_with_credits` must NOT be stamped so a later credit refill/measurement lifts the block.
    s.clear_quota_state("openai-oauth", ID_A).await.unwrap();
    probe.measure("openai-oauth", ID_A, true).await;
    assert_eq!(s.pool("openai-oauth").await.unwrap().account(ID_A).unwrap().has_credits, Some(true));
    fail_probe.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut unmeasured_429 = refusal(ErrorKind::QuotaExhausted, 429);
    unmeasured_429.error.reset_at = Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(reset_at as u64));
    let unmeasured_turn = Script::new(vec![(ID_A, vec![Err(unmeasured_429)])]);
    assert!(rotation.pool_send("openai-oauth", &send_ctx, &unmeasured_turn).await.is_err());
    assert_eq!(
        s.pool("openai-oauth").await.unwrap().account(ID_A).unwrap().blocked_with_credits,
        None,
        "stale pre-refusal has_credits must not stamp blocked_with_credits when refusal probe fails"
    );
    fail_probe.store(false, std::sync::atomic::Ordering::SeqCst);
    rotation.reset_probe_pacing();
    let recovered_after_probe = Script::new(vec![(ID_A, vec![Ok("recovered-after-probe")])]);
    assert!(rotation.pool_send("openai-oauth", &send_ctx, &recovered_after_probe).await.unwrap().starts_with("recovered-after-probe"));

    // Contrast 2: a 429 recorded while credits were NOT usable IS contradicted and lifted once credits become usable.
    s.clear_quota_state("openai-oauth", ID_A).await.unwrap();
    has_credits.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut depleted_429 = refusal(ErrorKind::QuotaExhausted, 429);
    depleted_429.error.reset_at = Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(reset_at as u64));
    let turn3 = Script::new(vec![(ID_A, vec![Err(depleted_429)])]);
    assert!(rotation.pool_send("openai-oauth", &send_ctx, &turn3).await.is_err());
    assert_eq!(s.pool("openai-oauth").await.unwrap().account(ID_A).unwrap().blocked_with_credits, None);

    has_credits.store(true, std::sync::atomic::Ordering::SeqCst);
    rotation.reset_probe_pacing();
    let turn4 = Script::new(vec![(ID_A, vec![Ok("recovered")])]);
    assert!(rotation.pool_send("openai-oauth", &send_ctx, &turn4).await.unwrap().starts_with("recovered"));
    assert_eq!(turn4.calls(), [ID_A]);
}

#[tokio::test]
async fn implicit_account_with_credits_still_pre_blocks_non_credit_model_buckets() {
    mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let s = store(&dir);
    let pace = clock();
    let now = pace.now_ms() as i64;
    let reset_at = now + 18_000_000;
    s.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();
    let rotation = AccountRotation::new(s, Arc::new(NoProbe), pace);

    let spark_full = super::model::Window {
        label: "7D Spark".into(),
        limit: Some("codex_bengalfox".into()),
        models: Some(vec!["spark".into()]),
        used_pct: Some(100.0),
        reset_at: Some(reset_at),
        ..super::model::Window::default()
    };
    let mut send_ctx = ctx();
    send_ctx.model = "gpt-5-codex-spark".into();
    send_ctx.implicit_plan_usage = Some(Account { usage: Some(super::model::Usage { windows: vec![spark_full], checked_at: now }), ..Account::new("default") });

    let script = Script::new(vec![]);
    let err = rotation.pool_send("openai-oauth", &send_ctx, &script).await.unwrap_err();
    assert!(err.quota_exhausted.is_some());
    assert!(script.calls().is_empty());
}
