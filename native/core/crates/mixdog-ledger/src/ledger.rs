//! The ledger as `usage-stats-api.mjs` uses it: every read first settles the writes queued
//! before it (a send's record is in the statistics requested after it), and a statistics read
//! also refreshes the prices of unpriced records.
//!
//! The history import of `getUsageStats` (`importUsageHistory`, in [`crate::history`]) runs
//! before the first statistics read, when the refresher has history enabled: the legacy usage
//! files and the earlier daemon's trace rows that the ledger does not hold yet are imported once.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;

use crate::error::Result;
use crate::quota::QuotaHistoryOptions;
use crate::reader::UsageReader;
use crate::refresh::UsageRefresher;
use crate::stats::UsageRequestsOptions;
use crate::stats::UsageStatsOptions;
use crate::writer::UsageWriter;

#[derive(Clone)]
pub struct UsageLedger {
    pub writer: Arc<UsageWriter>,
    pub reader: Arc<UsageReader>,
    pub refresher: Arc<UsageRefresher>,
}

impl UsageLedger {
    /// `getUsageStats`: settle the queued writes, import the legacy history that is not in the
    /// ledger yet, refresh unpriced records, then read.
    /// `clock` is `Date.now()`: read before the refresh and again for the statistics, so
    /// records the refresh touched are not beyond the read's clock.
    pub async fn get_usage_stats(&self, options: UsageStatsOptions, clock: impl Fn() -> i64) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.refresher.import_history(&self.writer, clock()).await?;
        self.refresher.refresh(&self.writer, &self.reader, clock()).await?;
        let stamp = self.writer.commit_stamp().await?;
        self.reader.stamped_stats(stamp, options, clock()).await
    }

    /// `getUsageRequests`: settle, then read one page.
    pub async fn get_usage_requests(&self, options: UsageRequestsOptions, real_now: i64) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.reader.usage_requests(options, real_now).await
    }

    /// `getQuotaHistory` (before the account service adds its labels): settle, then read.
    pub async fn get_quota_history(&self, options: QuotaHistoryOptions, in_use: BTreeMap<String, String>, now: i64) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.reader.quota_history(options, in_use, now).await
    }

    /// The totals of the sessions named, after the queued writes settle (`readSessionUsage`).
    pub async fn session_usage(&self, session_ids: Vec<String>, owner_ids: Vec<String>) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.reader.session_usage(session_ids, owner_ids).await
    }
}
