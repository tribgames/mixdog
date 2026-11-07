//! The account gate of a cache warm (`providers/cache-warm-admission.mjs`). A warm never waits,
//! queues, rotates accounts or retries: right before its POST it reads the state a normal send
//! consults for the account it goes to — the Developer option, the account's admission lane
//! (rate-limit cooldown, a lane throttled after a 429), the roster's blocks and quota windows, and
//! the session's quota-resume pause — and is skipped when any of them holds or when no fresh quota
//! reading says the account has room. A warm's own refusal is recorded like a send's: a 429 in the
//! lane cooldown, and the roster's verdict through the account pool.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::ProviderId;

use crate::accounts::{Account, Usage, Window};
use crate::accounts::policy::{account_exhausted, quota_reading_fresh, stale_quota_windows};
use crate::accounts::rotation::{AccountRotation, Failed};
use crate::accounts::{ACCOUNT_PROVIDERS, AccountStore};
use crate::admission::{Admission, Block, LaneKey, LaneSettings};
use crate::service::oauth_usage::{OAuthUsage, RouteInfo};

pub use mixdog_core_api::domain::cache_warm::{GateTarget, WarmGate};

/// `isOAuthProviderAvailable(name)` behind `providerAvailable`.
pub trait ProviderSwitch: Send + Sync {
    fn available(&self, provider: &str) -> bool;
}

/// `providerAvailable(name)` over the builder's own switch: the composition passes the registry
/// builder's `gated_off` (`!providerAvailable`, the stored Developer options read live), so the
/// gate and the registry answer from one reader.
pub struct GatedOff(pub Arc<dyn Fn(&str) -> bool + Send + Sync>);

impl ProviderSwitch for GatedOff {
    fn available(&self, provider: &str) -> bool {
        !(self.0)(provider)
    }
}

/// `quotaResumeEntry(sessionId)`: implemented by the quota-resume store itself
/// (`mixdog_core_base::quota_resume::QuotaResumeStore`).
pub trait QuotaResumes: Send + Sync {
    fn paused(&self, session_id: &str) -> bool;
}

/// `readCachedOAuthUsageSnapshot({ provider, model: '' })`: the stored reading of a provider
/// without a roster, `(quota windows, cached at)`.
#[async_trait]
pub trait UsageSnapshots: Send + Sync {
    async fn cached(&self, provider: &str) -> Option<(Vec<Window>, i64)>;
}

/// `readCachedOAuthUsageSnapshot({ provider, model: '' })` over the process's usage cache. A
/// provider without a roster is read under its `default` account (`currentProviderAccountId`); a
/// reading with no quota windows is none (the gate then reports "no fresh quota reading", as it
/// does for an absent one).
#[async_trait]
impl UsageSnapshots for OAuthUsage {
    async fn cached(&self, provider: &str) -> Option<(Vec<Window>, i64)> {
        let route = RouteInfo { provider: provider.to_owned(), model: String::new(), account_id: "default".to_owned() };
        let snapshot = self.read_cached(&route, false).await?;
        let windows = snapshot
            .get("quotaWindows")
            .and_then(serde_json::Value::as_array)?
            .iter()
            .map(|raw| serde_json::from_value(raw.clone()).unwrap_or_default())
            .collect();
        let cached_at = snapshot.get("cachedAt").and_then(serde_json::Value::as_f64).unwrap_or(0.0) as i64;
        Some((windows, cached_at))
    }
}

/// `readingBlock`: a reading that is missing, stale or not fresh blocks; so does an exhausted one.
fn reading_block(provider: &str, windows: Option<&[Window]>, checked_at: i64, now: i64, exhausted: bool) -> Option<&'static str> {
    let Some(windows) = windows else { return Some("no fresh quota reading") };
    if !quota_reading_fresh(checked_at, now) || stale_quota_windows(provider, windows) {
        return Some("no fresh quota reading");
    }
    exhausted.then_some("account blocked or quota exhausted")
}

/// `rosterBlock`'s decision over the roster as read: `accounts` (`None` when the provider has no
/// roster state) with `use_credits`, or, for an empty roster, the stored `snapshot`.
pub fn roster_block(
    provider: &str,
    account_id: &str,
    model: &str,
    now: i64,
    accounts: &[Account],
    use_credits: bool,
    snapshot: Option<&(Vec<Window>, i64)>,
) -> Option<&'static str> {
    if !ACCOUNT_PROVIDERS.contains(&provider) {
        return None;
    }
    if accounts.is_empty() {
        if use_credits {
            return None;
        }
        let row = snapshot.map(|(windows, checked_at)| {
            let mut row = Account::new("");
            row.usage = Some(Usage { windows: windows.clone(), checked_at: *checked_at });
            row
        });
        let exhausted = row.as_ref().is_some_and(|r| account_exhausted(r, now, model, false));
        return reading_block(provider, snapshot.map(|s| s.0.as_slice()), snapshot.map_or(0, |s| s.1), now, exhausted);
    }
    if account_id.is_empty() {
        return Some("account holding the cache unknown");
    }
    let Some(row) = accounts.iter().find(|a| a.id == account_id) else { return Some("account not connected") };
    let exhausted = account_exhausted(row, now, model, use_credits);
    if use_credits {
        return exhausted.then_some("account blocked");
    }
    let usage = row.usage.as_ref();
    reading_block(provider, usage.map(|u| u.windows.as_slice()), usage.map_or(0, |u| u.checked_at), now, exhausted)
}

/// The gate over the process's admission lanes, account roster and the three small seams above.
pub struct AccountGate {
    pub admission: Arc<Admission>,
    /// The settings the provider's ordinary sends open the lane with; a warm never creates a lane
    /// with different ones.
    pub lane_settings: Arc<dyn Fn(&LaneKey) -> LaneSettings + Send + Sync>,
    pub store: AccountStore,
    pub rotation: Arc<AccountRotation>,
    pub switch: Arc<dyn ProviderSwitch>,
    pub resumes: Arc<dyn QuotaResumes>,
    pub snapshots: Arc<dyn UsageSnapshots>,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl AccountGate {
    /// The gate of the process: its admission lanes and roster, the seams only the host knows
    /// (`isOAuthProviderAvailable`, `quotaResumeEntry`, `readCachedOAuthUsageSnapshot`), and the
    /// system clock.
    pub fn new(
        admission: Arc<Admission>,
        lane_settings: Arc<dyn Fn(&LaneKey) -> LaneSettings + Send + Sync>,
        store: AccountStore,
        rotation: Arc<AccountRotation>,
        switch: Arc<dyn ProviderSwitch>,
        resumes: Arc<dyn QuotaResumes>,
        snapshots: Arc<dyn UsageSnapshots>,
    ) -> Self {
        let now_ms = Arc::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64)
        });
        Self { admission, lane_settings, store, rotation, switch, resumes, snapshots, now_ms }
    }

    fn lane_key(target: &GateTarget) -> LaneKey {
        let account = if target.account_id.is_empty() { "default" } else { target.account_id.as_str() };
        LaneKey::new(ProviderId::from(target.provider.as_str()), account)
    }

    /// `cacheWarmAccountBlock(..., { now })`.
    pub async fn block_at(&self, target: &GateTarget, now: i64) -> Option<String> {
        if !self.switch.available(&target.provider) {
            return Some("provider disabled".to_owned());
        }
        let key = Self::lane_key(target);
        let lane = self.admission.lane(&key, (self.lane_settings)(&key));
        match self.admission.immediate_block(&lane) {
            Some(Block::Cooldown) => return Some("rate-limit cooldown".to_owned()),
            Some(Block::Throttled) => return Some("account throttled".to_owned()),
            None => {}
        }
        if !target.session_id.is_empty() && self.resumes.paused(&target.session_id) {
            return Some("session paused until its quota resets".to_owned());
        }
        if !ACCOUNT_PROVIDERS.contains(&target.provider.as_str()) {
            return None;
        }
        // A roster that cannot be read is not evidence of room.
        let Ok(pool) = self.store.pool(&target.provider).await else { return Some("account not connected".to_owned()) };
        let snapshot = if pool.accounts.is_empty() { self.snapshots.cached(&target.provider).await } else { None };
        roster_block(&target.provider, &target.account_id, &target.model, now, &pool.accounts, pool.uses_credits(), snapshot.as_ref())
            .map(str::to_owned)
    }
}

#[async_trait]
impl WarmGate for AccountGate {
    async fn block(&self, target: &GateTarget) -> Option<String> {
        self.block_at(target, (self.now_ms)()).await
    }

    async fn record_refusal(&self, target: &GateTarget, error: &ProviderError, aborted: bool) -> Result<(), String> {
        if aborted {
            return Ok(());
        }
        // The lane keeps 429s only.
        if error.status == Some(429) {
            let key = Self::lane_key(target);
            let lane = self.admission.lane(&key, (self.lane_settings)(&key));
            self.admission.record_rate_limit(&lane, error.retry_after);
        }
        if !target.account_id.is_empty() && ACCOUNT_PROVIDERS.contains(&target.provider.as_str()) {
            self.rotation
                .record_refusal(&target.provider, &target.account_id, &target.model, &Failed::new(error.clone()), None)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
