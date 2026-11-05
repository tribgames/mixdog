//! The price refresh (`usage-pricing-refresh.mjs`): when the price table changes, or new
//! unpriced records appear, records whose cost is unknown are repriced, and a known bill or
//! estimate is never overwritten. The decision (what changed since the last check, repair only
//! the appended rows when that is all there is) is the ledger's; the prices are not. The model
//! catalog stays outside this crate behind [`Pricer`].
//!
//! Lanes: the pending counts and the candidate rows are maintenance reads (an unbounded scan of
//! the unpriced rows), the pricing is CPU work on `cpu-bulk`, and the write is one transaction
//! on the writer thread; a refresh never holds the writer while it prices.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::CancellationToken;
use mixdog_rt::CpuBulk;
use mixdog_rt::LaneToken;
use rusqlite::params;

use crate::db::Connection;
use crate::error::LedgerError;
use crate::error::Result;
use crate::reader::UsageReader;
use crate::repair::PriceRequest;
use crate::repair::Priced;
use crate::repair::RepairOptions;
use crate::repair::RepairReport;
use crate::repair::plan_repair;
use crate::reply::ReplyTx;
use crate::reply::reply;
use crate::writer::UsageWriter;

/// The price table, from the model catalog (WP-AI-CORE).
pub trait Pricer: Send + Sync + 'static {
    /// The table's revision (`pricingCatalogRevisionSync()`): changes whenever any price may.
    /// It must come from a warm catalog; a cold one would stamp an empty revision as checked.
    fn revision(&self) -> String;

    fn price(&self, request: &PriceRequest) -> Result<Priced>;
}

/// Unpriced records up to a bound: how many, and the newest one's time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pending {
    pub count: i64,
    pub latest: Option<i64>,
}

/// `+e.ts` keeps the planner off `usage_events_time`: a bound of "now" matches every row, and
/// each index hit would cost a primary-key search (~300 ms against ~13 ms for a scan over 120k
/// real rows).
pub(crate) fn unpriced_pending(conn: &Connection, now: i64) -> Result<Pending> {
    Ok(conn.query_row(
        "SELECT COUNT(*),MAX(e.ts) FROM usage_events e JOIN usage_routes r ON r.id=e.route
         WHERE e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced' AND +e.ts<=?1",
        params![now],
        |r| {
            Ok(Pending {
                count: r.get(0)?,
                latest: r.get(1)?,
            })
        },
    )?)
}

/// Unpriced records appended after `latest`. When they account for every new unpriced record,
/// the rows at or before it were already examined under this price table.
pub(crate) fn unpriced_after(conn: &Connection, now: i64, latest: i64) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM usage_events e JOIN usage_routes r ON r.id=e.route
         WHERE e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced'
         AND +e.ts<=?1 AND +e.ts>?2",
        params![now, latest],
        |r| r.get(0),
    )?)
}

/// What a refresh did.
#[derive(Clone, Debug)]
pub enum Refresh {
    /// Nothing new to examine under this price table.
    Skipped,
    /// A repair pass ran; `conflict` means another writer repriced a planned row first, nothing
    /// was written, and the next refresh re-examines.
    Repaired(RepairReport),
}

#[derive(Clone)]
struct Checked {
    revision: String,
    pending: Pending,
    stamp: String,
}

#[derive(Default)]
struct State {
    checked: Option<Checked>,
    running: bool,
    waiters: Vec<ReplyTx<()>>,
}

/// One refresh at a time per ledger; a caller that arrives meanwhile waits for it and then
/// re-evaluates (an unchanged ledger skips).
pub struct UsageRefresher {
    pricer: Arc<dyn Pricer>,
    cpu_bulk: CpuBulk,
    state: Mutex<State>,
}

/// Ends a refresh however it ends: frees the slot and wakes its waiters.
struct Running<'a>(&'a UsageRefresher);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let waiters = {
            let mut state = self.0.lock();
            state.running = false;
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            waiter.send(());
        }
    }
}

impl UsageRefresher {
    pub fn new(pricer: Arc<dyn Pricer>, cpu_bulk: CpuBulk) -> Arc<Self> {
        Arc::new(Self {
            pricer,
            cpu_bulk,
            state: Mutex::new(State::default()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `refreshUnpricedUsageAsync`. `now_ms` is the clock at the call (`Date.now()`).
    pub async fn refresh(
        &self,
        writer: &Arc<UsageWriter>,
        reader: &Arc<UsageReader>,
        now_ms: i64,
    ) -> Result<Refresh> {
        let _running = loop {
            let wait = {
                let mut state = self.lock();
                if state.running {
                    let (tx, rx) = reply();
                    state.waiters.push(tx);
                    Some(rx)
                } else {
                    state.running = true;
                    None
                }
            };
            match wait {
                Some(rx) => {
                    let _ = rx.await;
                }
                None => break Running(self),
            }
        };
        self.run(writer, reader, now_ms).await
    }

    async fn run(
        &self,
        writer: &Arc<UsageWriter>,
        reader: &Arc<UsageReader>,
        now: i64,
    ) -> Result<Refresh> {
        let revision = self.pricer.revision();
        // Taken before anything is read: a commit landing later moves the stamp again, so the
        // next refresh can never skip it.
        let stamp = writer.commit_stamp().await?;
        let previous = self.lock().checked.clone();
        if previous
            .as_ref()
            .is_some_and(|p| p.revision == revision && p.stamp == stamp)
        {
            return Ok(Refresh::Skipped);
        }
        let pending = reader.unpriced_pending(now).await?;
        if pending.count == 0
            || previous
                .as_ref()
                .is_some_and(|p| p.revision == revision && p.pending == pending)
        {
            self.lock().checked = Some(Checked {
                revision,
                pending,
                stamp,
            });
            return Ok(Refresh::Skipped);
        }
        let incremental_from = match &previous {
            Some(p) if p.revision == revision => match p.pending.latest {
                Some(latest)
                    if p.pending.count + reader.unpriced_after(now, latest).await?
                        == pending.count =>
                {
                    Some(latest)
                }
                _ => None,
            },
            _ => None,
        };
        let options = RepairOptions {
            through_ts: now,
            since_ts: incremental_from,
            only_unpriced: true,
            backup: true,
            ..RepairOptions::default()
        };
        let candidates = reader.repair_candidates(options.clone()).await?;
        let (report, changes) = {
            let pricer = self.pricer.clone();
            let plan_options = options.clone();
            let job = move |_: &mixdog_rt::InLane<CpuBulk>| {
                plan_repair(candidates, &plan_options, &mut |request| {
                    pricer.price(request)
                })
            };
            self.cpu_bulk
                .submit(&CancellationToken::new(), job)
                .map_err(|_| LedgerError::Busy { queue: "cpu-bulk" })?
                .await
                .map_err(|_| LedgerError::Stopped)??
        };
        let result = writer.apply_repair(report, changes, options, now).await?;
        if result.conflict {
            return Ok(Refresh::Repaired(result));
        }
        let settled_stamp = writer.commit_stamp().await?;
        let settled = reader.unpriced_pending(now).await?;
        self.lock().checked = Some(Checked {
            revision,
            pending: settled,
            stamp: settled_stamp,
        });
        Ok(Refresh::Repaired(result))
    }
}
