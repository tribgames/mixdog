//! The ledger as `usage-stats-api.mjs` uses it: every read first settles the writes queued
//! before it (a send's record is in the statistics requested after it), and a statistics read
//! also refreshes the prices of unpriced records.
//!
//! The history import of `getUsageStats` (`importUsageHistory`) is not here by decision: the
//! core never reimplements the importer. A ledger the 1.4.5 daemon already imported
//! (`metadata.importedThrough`) is read as it is, and one it did not import is held by the
//! migration (`ledger_import_incomplete`, store-migration §4).

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
    /// `getUsageStats`: settle the queued writes, refresh unpriced records, then read.
    /// `clock` is `Date.now()`: read before the refresh and again for the statistics, so
    /// records the refresh touched are not beyond the read's clock.
    pub async fn get_usage_stats(
        &self,
        options: UsageStatsOptions,
        clock: impl Fn() -> i64,
    ) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.refresher
            .refresh(&self.writer, &self.reader, clock())
            .await?;
        self.reader.usage_stats(options, clock()).await
    }

    /// `getUsageRequests`: settle, then read one page.
    pub async fn get_usage_requests(
        &self,
        options: UsageRequestsOptions,
        real_now: i64,
    ) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.reader.usage_requests(options, real_now).await
    }

    /// `getQuotaHistory` (before the account service adds its labels): settle, then read.
    pub async fn get_quota_history(
        &self,
        options: QuotaHistoryOptions,
        in_use: BTreeMap<String, String>,
        now: i64,
    ) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.reader.quota_history(options, in_use, now).await
    }

    /// The totals of the sessions named, after the queued writes settle (`readSessionUsage`).
    pub async fn session_usage(
        &self,
        session_ids: Vec<String>,
        owner_ids: Vec<String>,
    ) -> Result<Value> {
        self.writer.settle_writes().await?;
        self.reader.session_usage(session_ids, owner_ids).await
    }
}
