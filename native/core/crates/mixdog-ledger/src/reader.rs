//! The ledger's query API on its lanes (RL §7.2, §8.3): reads never go through the writer and
//! never run on an async task.
//!
//! * `io-interactive` serves reads whose cost is bounded by their shape: aggregate tables
//!   restricted by a day range, one page of the request log, a session's sums, the cached
//!   rollup days.
//! * `io-maintenance` serves reads that visit an unbounded number of rows: a rollup cut below
//!   whole days (it folds the period's retained events), the hour view, and the quota history
//!   (every reading of a window plus the fitted split, which is also CPU-heavy).
//!
//! Every read runs as one lane job on its own read-only connection, so a slow quota fit can
//! never delay a request-log page, and the WAL snapshot a read sees is never blocked by the
//! writer. A full lane answers [`LedgerError::Busy`] at once instead of queueing without bound.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use rusqlite::OpenFlags;
use serde_json::Value;

use crate::db::Connection;
use crate::error::LedgerError;
use crate::error::Result;
use crate::quota::QuotaHistoryOptions;
use crate::quota::get_quota_history;
use crate::refresh::Pending;
use crate::refresh::unpriced_after;
use crate::refresh::unpriced_pending;
use crate::repair::Candidate;
use crate::repair::RepairOptions;
use crate::repair::select_candidates;
use crate::requests::RequestQuery;
use crate::requests::read_request_models;
use crate::requests::read_request_rows;
use crate::rollup::RollupQuery;
use crate::rollup::rollup_usage;
use crate::stats::UsageRequestsOptions;
use crate::stats::UsageStatsOptions;
use crate::stats::requests_plan;
use crate::stats::usage_stats;
use crate::sums::read_session_usage;
use crate::sums::read_usage_token;

/// Read connections kept per lane; a job that finds the pool empty opens one.
const POOL: usize = 4;

#[allow(
    clippy::disallowed_methods,
    reason = "opens a connection inside a lane job; never on an async task"
)]
pub(crate) fn open_reader(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch("PRAGMA query_only=1")?;
    Ok(conn)
}

#[derive(Default)]
struct Pool(Mutex<Vec<Connection>>);

impl Pool {
    fn with<T>(&self, path: &Path, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let held = self.0.lock().unwrap_or_else(|p| p.into_inner()).pop();
        let conn = match held {
            Some(conn) => conn,
            None => open_reader(path)?,
        };
        // One deferred read transaction per job: the first statement opens the WAL snapshot and
        // every later one (a rollup issues several) sees it, whatever the writer commits
        // meanwhile.
        conn.execute_batch("BEGIN")?;
        let out = f(&conn);
        // A connection that cannot end its transaction is not kept.
        if conn.execute_batch("COMMIT").is_ok() {
            let mut pool = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if pool.len() < POOL {
                pool.push(conn);
            }
        }
        out
    }
}

/// The lane a read runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadLane {
    Interactive,
    Maintenance,
}

/// Reader of one ledger file on the process's lanes.
pub struct UsageReader {
    path: PathBuf,
    interactive: InteractiveIo,
    maintenance: MaintenanceIo,
    interactive_pool: Pool,
    maintenance_pool: Pool,
}

impl UsageReader {
    pub fn new(path: &Path, interactive: InteractiveIo, maintenance: MaintenanceIo) -> Arc<Self> {
        Arc::new(Self {
            path: path.to_path_buf(),
            interactive,
            maintenance,
            interactive_pool: Pool::default(),
            maintenance_pool: Pool::default(),
        })
    }

    async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        lane: ReadLane,
        read: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let me = self.clone();
        let cancel = CancellationToken::new();
        match lane {
            ReadLane::Interactive => {
                let job = move |_: &InLane<InteractiveIo>| me.interactive_pool.with(&me.path, read);
                self.interactive
                    .submit(&cancel, job)
                    .map_err(|_| LedgerError::Busy {
                        queue: "io-interactive",
                    })?
                    .await
            }
            ReadLane::Maintenance => {
                let job = move |_: &InLane<MaintenanceIo>| me.maintenance_pool.with(&me.path, read);
                self.maintenance
                    .submit(&cancel, job)
                    .map_err(|_| LedgerError::Busy {
                        queue: "io-maintenance",
                    })?
                    .await
            }
        }
        .map_err(|_| LedgerError::Stopped)?
    }

    /// The lane a rollup runs on: a window cut below whole days, or an hourly day, folds the
    /// period's events.
    pub fn rollup_lane(query: &RollupQuery) -> ReadLane {
        if query.from_ms.is_some() || query.hourly_day.is_some() {
            ReadLane::Maintenance
        } else {
            ReadLane::Interactive
        }
    }

    /// The lane `getUsageStats` runs on: the hour view and clock-narrowed ranges fold events.
    pub fn stats_lane(options: &UsageStatsOptions) -> ReadLane {
        let clock = |t: &Option<String>| t.as_deref().is_some_and(|t| !t.is_empty());
        if options.view.as_deref() == Some("hour")
            || clock(&options.start_time)
            || clock(&options.end_time)
        {
            ReadLane::Maintenance
        } else {
            ReadLane::Interactive
        }
    }

    /// `getUsageStats`.
    pub async fn usage_stats(
        self: &Arc<Self>,
        options: UsageStatsOptions,
        now: i64,
    ) -> Result<Value> {
        let lane = Self::stats_lane(&options);
        self.run(lane, move |conn| usage_stats(conn, &options, now))
            .await
    }

    /// `getUsageRequests`: one page of the request log (requests unlabelled by session); the
    /// first page runs on the maintenance lane (see [`Self::requests_lane`]).
    pub async fn usage_requests(
        self: &Arc<Self>,
        options: UsageRequestsOptions,
        real_now: i64,
    ) -> Result<Value> {
        let plan = requests_plan(&options, real_now)?;
        let page = self.requests_page(plan.query.clone()).await?;
        Ok(plan.envelope(&page))
    }

    /// One page of the request log for explicit bounds: `{requests, nextCursor, models}`
    /// (`models` is `null` after the first page).
    pub async fn requests_page(self: &Arc<Self>, query: RequestQuery) -> Result<Value> {
        let lane = Self::requests_lane(&query);
        self.run(lane, move |conn| {
            let mut page = read_request_rows(conn, &query)?;
            page["models"] = if query.is_first_page() {
                read_request_models(conn, query.from_ms, query.to_ms)?
            } else {
                Value::Null
            };
            Ok(page)
        })
        .await
    }

    /// The lane of a request page. A later page is an index-bounded interactive read. The first
    /// page also lists the models, which visits every route, so it is one maintenance job: its
    /// rows and its models list come from one snapshot.
    pub fn requests_lane(query: &RequestQuery) -> ReadLane {
        if query.is_first_page() {
            ReadLane::Maintenance
        } else {
            ReadLane::Interactive
        }
    }

    /// A rollup document (`{days, hourly?}`).
    pub async fn rollup(self: &Arc<Self>, query: RollupQuery) -> Result<Value> {
        let lane = Self::rollup_lane(&query);
        self.run(lane, move |conn| Ok(rollup_usage(conn, &query)?.to_value()))
            .await
    }

    /// The totals of the sessions named, and of the sessions recorded as run for `owner_ids`.
    pub async fn session_usage(
        self: &Arc<Self>,
        session_ids: Vec<String>,
        owner_ids: Vec<String>,
    ) -> Result<Value> {
        self.run(ReadLane::Interactive, move |conn| {
            read_session_usage(conn, &session_ids, &owner_ids)
        })
        .await
    }

    /// Unpriced records up to `now` (a maintenance read: it scans them all).
    pub async fn unpriced_pending(self: &Arc<Self>, now: i64) -> Result<Pending> {
        self.run(ReadLane::Maintenance, move |conn| {
            unpriced_pending(conn, now)
        })
        .await
    }

    /// Unpriced records appended after `latest`.
    pub async fn unpriced_after(self: &Arc<Self>, now: i64, latest: i64) -> Result<i64> {
        self.run(ReadLane::Maintenance, move |conn| {
            unpriced_after(conn, now, latest)
        })
        .await
    }

    /// The rows a repair examines (`selectUsageRepairCandidates`).
    pub async fn repair_candidates(
        self: &Arc<Self>,
        options: RepairOptions,
    ) -> Result<Vec<Candidate>> {
        self.run(ReadLane::Maintenance, move |conn| {
            select_candidates(conn, &options)
        })
        .await
    }

    /// The change token of a group of sessions (see [`read_usage_token`]).
    pub async fn usage_token(
        self: &Arc<Self>,
        session_ids: Vec<String>,
        owner_ids: Vec<String>,
    ) -> Result<String> {
        self.run(ReadLane::Interactive, move |conn| {
            read_usage_token(conn, &session_ids, &owner_ids)
        })
        .await
    }

    /// `getQuotaHistory` (before the account service adds its labels).
    pub async fn quota_history(
        self: &Arc<Self>,
        options: QuotaHistoryOptions,
        in_use: std::collections::BTreeMap<String, String>,
        now: i64,
    ) -> Result<Value> {
        self.run(ReadLane::Maintenance, move |conn| {
            get_quota_history(conn, &options, &in_use, now)
        })
        .await
    }
}

#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    reason = "test fixture: a second connection plays the writer"
)]
mod tests {
    use super::*;

    /// A job's statements all read the snapshot its first statement opened: a commit that lands
    /// between two of them (a rollup issues several) never shows in the same answer.
    #[test]
    fn a_job_reads_one_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1)")
            .unwrap();
        let pool = Pool::default();
        let count = |conn: &Connection| {
            conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get::<_, i64>(0))
        };

        let (before, after) = pool
            .with(&path, |conn| {
                let before = count(conn)?;
                writer.execute("INSERT INTO t VALUES (2)", [])?;
                Ok((before, count(conn)?))
            })
            .unwrap();
        assert_eq!((before, after), (1, 1));

        // The next job, on the same pooled connection, opens a fresh snapshot.
        assert_eq!(pool.with(&path, |conn| Ok(count(conn)?)).unwrap(), 2);
    }
}
