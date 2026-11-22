//! `thread/window/set`: the ranges of the transcript a positioned subscription holds, changed at a feed fence.
//!
//! The demand names positions; the pages that resolve them are the stored units every positioned row comes from
//! ([`reads::units`]). A demand is read in the actor's line of unit reads ([`super::actor`]'s `UnitJob`), the same line
//! that sends each stored record's unit to the subscriptions that hold it: no unit is sent between the read and the
//! grant it makes, so the ranges installed at the fence ([`FeedSource::regrant`]) are exactly the rows
//! `thread/window/changed` carries. A record stored before the read is in it; one stored after is sent behind the
//! fence, by the new grant.

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::RewindTarget;
use mixdog_app_protocol::v2::thread::ThreadRewindTargetsListParams;
use mixdog_app_protocol::v2::thread::ThreadRewindTargetsListResponse;
use mixdog_app_protocol::v2::thread::ThreadWindowChangedParams;
use mixdog_app_protocol::v2::thread::ThreadWindowSetParams;
use mixdog_app_protocol::v2::thread::WindowAdded;
use mixdog_app_protocol::v2::thread::WindowEdge;
use mixdog_app_protocol::v2::thread::WindowRange;
use mixdog_app_protocol::v2::thread::WindowRangeWant;
use mixdog_app_protocol::v2::thread::WindowWant;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::Grant;
use mixdog_core_api::feed::GrantRange;
use mixdog_core_api::ids::SubscriptionId;
use serde_json::Value;

use mixdog_core_api::ids::ThreadId;

use super::SessionDeps;
use super::handle::SessionHandle;
use super::read_trace::ReadCtl;
use super::reads;
use super::reads::StoredUnit;
use super::seams::PageAt;
use super::view::TAIL_RANGE;

/// The newest records a demand for the tail acquires, and a positioned snapshot carries at most.
pub(crate) const TAIL_RECORDS: usize = 32;
/// The most records one wanted range reads on either side of its position (`CURSOR_PAGE_MAX_ROWS`).
const MAX_RECORDS: usize = 512;

pub(crate) const WINDOW_CHANGED: &str = "thread/window/changed";

/// A range the subscription is to hold; `units` when its contents are newly held.
pub(crate) struct Wanted {
    pub range: GrantRange,
    pub units: Option<Vec<StoredUnit>>,
    /// The unit of `units` the range was asked at: it stays whatever is dropped to fit.
    keep: usize,
}

pub(crate) struct Demand {
    pub ranges: Vec<Wanted>,
    pub tail_from: Option<u64>,
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

pub(crate) fn other_version(expected: u64, actual: impl Into<Arc<str>>) -> CoreError {
    CoreError::PreconditionFailed {
        precondition: mixdog_core_api::error::Precondition::Revision { expected: expected.to_string().into(), actual: actual.into() },
    }
}

fn edge(position: &Option<Arc<str>>) -> WindowEdge {
    match position {
        Some(position) => WindowEdge::Continuation { position: position.to_string() },
        None => WindowEdge::End,
    }
}

/// The ranges of a grant as `thread/window/changed` lists them.
pub(crate) fn wire_ranges(ranges: &[GrantRange]) -> Vec<WindowRange> {
    ranges.iter().map(|range| WindowRange { id: range.id.to_string(), older: edge(&range.older), newer: edge(&range.newer) }).collect()
}

/// Whole units dropped from the far end (`front`: the oldest) until at most `rows` rows are left, never the last unit.
fn trim(units: &mut Vec<StoredUnit>, rows: usize, front: bool) -> bool {
    let mut trimmed = false;
    while units.len() > 1 && units.iter().map(|unit| unit.unit.items.len()).sum::<usize>() > rows.max(1) {
        if front {
            units.remove(0);
        } else {
            units.pop();
        }
        trimmed = true;
    }
    trimmed
}

/// The range `units` make: `None` when there are none.
fn range_of(id: &str, units: &[StoredUnit], reaches_start: bool, reaches_end: bool) -> Option<GrantRange> {
    let (first, last) = units.first().zip(units.last())?;
    let (from, to): (Arc<str>, Arc<str>) = (Arc::from(first.unit.position.as_str()), Arc::from(last.unit.position.as_str()));
    Some(GrantRange {
        id: Arc::from(id),
        first: first.ordinal,
        last: last.ordinal,
        older: (!reaches_start).then(|| from.clone()),
        newer: (!reaches_end).then(|| to.clone()),
        from,
        to,
    })
}

async fn page(deps: &SessionDeps, id: &ThreadId, at: PageAt, records: usize, lineage: u64, ctl: &ReadCtl) -> Result<reads::Units, CoreError> {
    let page = reads::units(&deps.store, &deps.transcript, deps.lanes, id, at, records.min(MAX_RECORDS), ctl)
        .await?
        .ok_or_else(|| invalid("want", "a position of this thread's history"))?;
    // A page of another history revision is of ranges this grant does not name.
    if page.rev != lineage {
        return Err(other_version(lineage, page.rev.to_string()));
    }
    Ok(page)
}

/// The range around `position`: its record, up to `around.0` rows older and `around.1` rows newer, whole records only.
async fn range(
    deps: &SessionDeps,
    id: &ThreadId,
    name: String,
    position: &str,
    around: (usize, usize),
    lineage: u64,
    ctl: &ReadCtl,
) -> Result<Wanted, CoreError> {
    let (before, after) = around;
    let unknown = || invalid("want", "a position of this thread's history");
    // A record has one position, whichever of its rows the client named.
    let anchor = reads::record_position(reads::history_cursor_iid(position).ok_or_else(unknown)?);
    let older = page(deps, id, PageAt::Before(anchor.clone()), before, lineage, ctl).await?;
    let mut units = older.units;
    // The named record is the page's last, when it shows rows.
    let Some(named) = units.last().filter(|unit| unit.unit.position == anchor) else { return Err(unknown()) };
    let (ordinal, rows) = (named.ordinal, named.unit.items.len());
    // The anchor's own rows are held whatever the count: a record travels whole.
    let trimmed = trim(&mut units, before.saturating_add(rows), true);
    let reaches_start = older.reaches_start && !trimmed;
    let keep = units.len() - 1;
    let mut reaches_end = false;
    if after > 0 {
        let newer = page(deps, id, PageAt::After(anchor), after, lineage, ctl).await?;
        let mut more: Vec<StoredUnit> = newer.units.into_iter().filter(|unit| unit.ordinal > ordinal).collect();
        let trimmed = trim(&mut more, after, false);
        reaches_end = newer.reaches_end && !trimmed;
        units.extend(more);
    }
    let range = range_of(&name, &units, reaches_start, reaches_end).ok_or_else(unknown)?;
    Ok(Wanted { range, units: Some(units), keep })
}

/// What one `thread/window/changed` carries beside its units.
const FRAME_OVERHEAD: usize = 16 << 10;

/// The newly held units, cut to what one message of `budget` bytes delivers: whole units are dropped from a range's far
/// ends, never the record it was asked at, and the range then says where it continues. Refused when the records asked
/// at do not fit together.
fn fit(ranges: &mut [Wanted], budget: usize) -> Result<(), CoreError> {
    let mut room = budget.saturating_sub(FRAME_OVERHEAD);
    for wanted in ranges.iter_mut() {
        let Some(units) = wanted.units.as_mut() else { continue };
        let held = |units: &[StoredUnit]| units.iter().map(|unit| unit.bytes).sum::<usize>();
        let (mut cut_older, mut cut_newer) = (false, false);
        while held(units) > room {
            if wanted.keep > 0 {
                units.remove(0);
                wanted.keep -= 1;
                cut_older = true;
            } else if units.len() > 1 {
                units.pop();
                cut_newer = true;
            } else {
                return Err(invalid("want", "ranges whose records fit one window change"));
            }
        }
        room -= held(units);
        let (reaches_start, reaches_end) = (wanted.range.older.is_none() && !cut_older, wanted.range.newer.is_none() && !cut_newer);
        if let Some(range) = range_of(&wanted.range.id, units, reaches_start, reaches_end) {
            wanted.range = range;
        }
    }
    Ok(())
}

/// The ranges `want` asks for, with the contents of those `held` does not hold, all from this one read.
pub(crate) async fn demand(
    deps: &SessionDeps,
    id: &ThreadId,
    held: &Grant,
    request: &str,
    want: &WindowWant,
    budget: usize,
    ctl: &ReadCtl,
) -> Result<Demand, CoreError> {
    let lineage = held.lineage;
    let retained = |id: &str| held.ranges.iter().find(|range| &*range.id == id).cloned();
    let mut ranges = Vec::new();
    for (index, wanted) in want.ranges.iter().enumerate() {
        let name = format!("q:{request}:{index}");
        let rows = |rows: &u32| *rows as usize;
        ranges.push(match wanted {
            WindowRangeWant::Retain { id } => {
                Wanted { range: retained(id).ok_or_else(|| invalid("want.ranges", "ids of ranges the subscription holds"))?, units: None, keep: 0 }
            }
            WindowRangeWant::Before { position, rows: before } => range(deps, id, name, position, (rows(before), 0), lineage, ctl).await?,
            WindowRangeWant::After { position, rows: after } => range(deps, id, name, position, (0, rows(after)), lineage, ctl).await?,
            WindowRangeWant::Around { position, before, after } => range(deps, id, name, position, (rows(before), rows(after)), lineage, ctl).await?,
        });
    }
    for position in &want.pinned {
        let name = format!("pin:{position}");
        ranges.push(match retained(&name) {
            Some(range) => Wanted { range, units: None, keep: 0 },
            None => range(deps, id, name, position, (0, 0), lineage, ctl).await?,
        });
    }
    let keeps_tail = held.tail_from.is_some() && ranges.iter().any(|wanted| &*wanted.range.id == TAIL_RANGE);
    let tail_from = match (want.follow_tail, keeps_tail) {
        (true, true) => held.tail_from,
        // The newest records, held from here on as they arrive.
        (true, false) => {
            ranges.retain(|wanted| &*wanted.range.id != TAIL_RANGE);
            let newest = page(deps, id, PageAt::Newest, TAIL_RECORDS, lineage, ctl).await?;
            let from = newest.units.last().map_or(0, |last| last.ordinal + 1);
            if let Some(range) = range_of(TAIL_RANGE, &newest.units, newest.reaches_start, true) {
                let keep = newest.units.len() - 1;
                ranges.push(Wanted { range, units: Some(newest.units), keep });
            }
            Some(from)
        }
        // The tail it followed ends at the last record it was sent; what is stored later is beyond its newer edge.
        (false, true) => {
            if let Some(tail) = ranges.iter_mut().find(|wanted| &*wanted.range.id == TAIL_RANGE) {
                tail.range.newer = Some(tail.range.to.clone());
            }
            None
        }
        (false, false) => None,
    };
    fit(&mut ranges, budget)?;
    Ok(Demand { ranges, tail_from })
}

/// `thread/window/changed` for the grant `demand` made of `held` at `fence`.
pub(crate) fn changed(
    id: &ThreadId,
    params: &ThreadWindowSetParams,
    held: &Grant,
    demand: Demand,
    version: u64,
    at: &mixdog_core_api::feed::FeedPosition,
) -> ThreadWindowChangedParams {
    let ranges: Vec<GrantRange> = demand.ranges.iter().map(|wanted| wanted.range.clone()).collect();
    let removed = held.ranges.iter().filter(|old| !ranges.iter().any(|range| range.id == old.id)).map(|old| old.id.to_string()).collect();
    let added = demand
        .ranges
        .into_iter()
        .filter_map(|wanted| Some(WindowAdded { range: wanted.range.id.to_string(), units: wanted.units?.into_iter().map(|unit| unit.unit).collect() }))
        .collect();
    ThreadWindowChangedParams {
        thread_id: id.clone(),
        subscription_id: params.subscription_id.clone(),
        request_id: Some(params.request_id.clone()),
        window_version: version,
        lineage: held.lineage,
        at_feed_position: mixdog_app_protocol::v2::feed::FeedPosition { epoch: at.epoch.clone(), seq: at.seq },
        ranges: wire_ranges(&ranges),
        removed,
        added,
        follow_tail: demand.tail_from.is_some(),
    }
}

impl SessionHandle {
    /// The prompt a client's id names in the stored history, with the id the transcript ends with after a rewind to
    /// it; `None` when no live prompt is named.
    pub(crate) async fn stored_rewind(
        &self,
        shown: &str,
        cancel: &mixdog_rt::CancellationToken,
    ) -> Result<Option<(super::seams::StoredRewind, Option<String>)>, CoreError> {
        let deps = &self.deps;
        deps.store.unheld().await;
        let (store, thread, shown) = (deps.store.clone(), self.id.clone(), shown.to_owned());
        let found = mixdog_core_base::support::on_lane_wait(deps.lanes.io, cancel, move |lane| store.rewind_target(lane, &thread, &shown)).await??;
        let Some(stored) = found else { return Ok(None) };
        let previous = match stored.previous.clone() {
            Some(record) => {
                let transcript = deps.transcript.clone();
                // The row a client holds last: a user row shows its submission id.
                mixdog_core_base::support::on_lane_wait(deps.lanes.cpu, cancel, move |lane| {
                    transcript.rows(lane, &record).last().map(|(item, _)| super::transcript::displayed_id(item).to_owned())
                })
                .await?
            }
            None => None,
        };
        Ok(Some((stored, previous)))
    }

    /// `thread/rewindTargets/list`: the prompts a rewind can name, newest first, from the stored history.
    pub(crate) async fn rewind_targets_list(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let p: ThreadRewindTargetsListParams = serde_json::from_value(req.params.clone()).map_err(|_| invalid("params", "ThreadRewindTargetsListParams"))?;
        let limit = match p.limit {
            None => 50,
            Some(limit) if (1..=200).contains(&limit) => limit as usize,
            Some(_) => return Err(invalid("limit", "1 to 200")),
        };
        let before = match &p.cursor {
            None => None,
            Some(cursor) => {
                Some(cursor.strip_prefix("o:").and_then(|ordinal| ordinal.parse::<u64>().ok()).ok_or_else(|| invalid("cursor", "a cursor of this list"))?)
            }
        };
        let deps = &self.deps;
        deps.store.unheld().await;
        let (store, thread) = (deps.store.clone(), self.id.clone());
        // One more than asked says whether more are left.
        let read = mixdog_core_base::support::on_lane_wait(deps.lanes.io, &req.ctx.cancel, move |lane| store.rewind_targets(lane, &thread, before, limit + 1));
        let (_, mut targets) = read.await??;
        let more = targets.len() > limit;
        targets.truncate(limit);
        let next_cursor = targets.last().filter(|_| more).map(|target| format!("o:{}", target.ordinal));
        let data = targets.into_iter().map(|target| RewindTarget { position: reads::record_position(&target.iid), text: target.text }).collect();
        let listed = ThreadRewindTargetsListResponse { data, next_cursor };
        Ok(Reply::Value(serde_json::to_value(listed).unwrap_or(Value::Null)))
    }

    /// `thread/window/set`: asked of the actor, which reads the demand in its line of unit reads and installs it.
    pub(crate) async fn window_set(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadWindowSetParams = serde_json::from_value(req.params.clone()).map_err(|_| invalid("params", "ThreadWindowSetParams"))?;
        let sub = SubscriptionId::from(params.subscription_id.as_str());
        let unknown = || invalid("subscriptionId", "a positioned subscription of this thread the caller holds");
        // A subscription is its connection's: no other connection changes what its lane is sent.
        if let mixdog_core_api::call::Caller::Connection(caller) = &req.ctx.caller
            && self.subscriptions.owner(&sub) != Some(*caller)
        {
            return Err(unknown());
        }
        if self.subscriptions.grant(&sub).is_none() {
            return Err(unknown());
        }
        let closing = || CoreError::ThreadClosing { thread_id: self.id.clone() };
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.inbox.send(super::actor::Inbox::WindowDemand { params, cancel: req.ctx.cancel.clone(), tx }).await.map_err(|_| closing())?;
        rx.await.map_err(|_| closing())?
    }
}
