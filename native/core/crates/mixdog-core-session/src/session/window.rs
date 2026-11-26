//! `thread/window/set`: the ranges of the transcript a positioned subscription holds, changed at a feed fence.
//!
//! The demand names positions; the pages that resolve them are the stored units every positioned row comes from
//! ([`reads::transcript_units`]). A demand is read in the actor's line of unit reads ([`super::actor`]'s `UnitJob`), the same line
//! that sends each stored record's unit to the subscriptions that hold it: no unit is sent between the read and the
//! grant it makes, so the ranges installed at the fence ([`FeedSource::regrant`]) are exactly the rows
//! `thread/window/changed` carries. A record stored before the read is in it; one stored after is sent behind the
//! fence, by the new grant.

use std::collections::HashMap;
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
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::Grant;
use mixdog_core_api::feed::GrantRange;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ThreadItem;
use serde_json::Value;

use super::SessionDeps;
use super::handle::SessionHandle;
use super::read_trace::ReadCtl;
use super::reads;
use super::reads::StoredUnit;
use super::seams::PageAt;
use super::view::TAIL_RANGE;

/// The newest records a demand for the tail acquires when re-attaching `followTail`.
pub(crate) const TAIL_RECORDS: usize = 64;
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

/// The calls of the turns running now, and those of an ended turn whose stored result the record that made them is
/// still to be read with, by call id, as the session's released entries tell them in their order: the one
/// source of how such a call reads in a unit, whichever producer sends it (a snapshot's tail, a record sent to the
/// subscriptions that hold it, a range a demand reads). A call here reads open, or closed with the result shown
/// ahead of its row; a call not here reads as the records store it: with its stored result, or ended without one.
/// A stored result is never held: it is the records' ([`reads::transcript_units`] finds it at any distance), and its call leaves
/// once the record that made it is read with it.
#[derive(Clone, Default)]
pub(crate) struct Calls {
    by_id: HashMap<String, Call>,
    /// The results shown ahead of the stored record that made their call, by call id with the call's turn: a record is
    /// shown before it is stored, and a call that ends at once is shown ended in between.
    ahead: HashMap<String, (String, Arc<ThreadItem>)>,
}

#[derive(Clone)]
struct Call {
    turn: String,
    /// The stored record that made the call.
    record: String,
    /// The result shown ahead of its row; `None` while the call runs.
    ended: Option<Arc<ThreadItem>>,
    /// The call's result is stored: the next read of `record` carries it.
    stored: bool,
}

impl Calls {
    /// The stored record `record` of the running turn `turn` made `call`: closed already when its result was shown
    /// before the record was stored.
    pub fn opened(&mut self, call: &str, turn: &str, record: &str) {
        let ended = self.ahead.remove(call).filter(|(of, _)| of == turn).map(|(_, update)| update);
        self.by_id.insert(call.to_owned(), Call { turn: turn.to_owned(), record: record.to_owned(), ended, stored: false });
    }

    /// `call` of the running turn `turn` ended with the result `update` carries; `stored`: its row is stored, else it
    /// was shown ahead of its row. The record that made the call, when it reads differently for it: a result shown
    /// ahead changes nothing of a stored one, and closes a call whose record is not stored yet once it is.
    pub fn ended(&mut self, call: &str, turn: &str, update: &ThreadItem, stored: bool) -> Option<String> {
        let Some(held) = self.by_id.get_mut(call).filter(|held| held.turn == turn) else {
            if !stored {
                self.ahead.insert(call.to_owned(), (turn.to_owned(), Arc::new(update.clone())));
            }
            return None;
        };
        if stored {
            held.stored = true;
        } else if held.stored {
            return None;
        } else {
            held.ended = Some(Arc::new(update.clone()));
        }
        Some(held.record.clone())
    }

    /// `unit` is read as the records store it: each call it shows with its stored result leaves, and each its record
    /// made that it shows no row of.
    pub fn read(&mut self, unit: &StoredUnit) {
        let closed = |call: &str| {
            unit.unit.items.iter().find_map(|item| match item {
                ThreadItem::ToolCall { run, .. } if run.call_id.as_deref() == Some(call) => Some(run.result.is_some()),
                _ => None,
            })
        };
        self.by_id.retain(|call, held| !held.stored || !closed(call).unwrap_or_else(|| unit.unit.position == reads::record_position(&held.record)));
    }

    /// The turn `turn` ended: its calls no result was stored for read as the records store them from here on, ended
    /// without one. Their records, which read differently for it. A call whose result is stored stays as it reads
    /// until the read of its record that carries the result ([`Self::read`]).
    pub fn turn_ended(&mut self, turn: &str) -> Vec<String> {
        self.ahead.retain(|_, (of, _)| of != turn);
        let mut records = Vec::new();
        self.by_id.retain(|_, call| {
            if call.turn != turn || call.stored {
                return true;
            }
            if !records.contains(&call.record) {
                records.push(std::mem::take(&mut call.record));
            }
            false
        });
        records
    }

    /// No read of a record with its call's stored result is left to wait for: what the positioned subscriptions hold
    /// is read anew from the records (the history was cut, or a read failed and they hold nothing).
    pub fn reread(&mut self) {
        self.by_id.retain(|_, call| !call.stored);
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty() && self.ahead.is_empty()
    }

    fn held(&self, item: &ThreadItem) -> Option<&Call> {
        let ThreadItem::ToolCall { run, .. } = item else { return None };
        // A result the records store is the call's own, whatever was shown ahead of it.
        if run.result.is_some() {
            return None;
        }
        self.by_id.get(run.call_id.as_deref()?)
    }

    /// `unit` with each of its calls held here as it stands; `None` when it shows none of them.
    pub fn settled(&self, unit: &StoredUnit) -> Option<StoredUnit> {
        if !unit.unit.items.iter().any(|item| self.held(item).is_some()) {
            return None;
        }
        let mut settled = unit.clone();
        for item in &mut settled.unit.items {
            let Some(call) = self.held(item) else { continue };
            match &call.ended {
                Some(update) => closed_with(item, update),
                None => super::live_end::open_call(item),
            }
        }
        settled.bytes = reads::unit_bytes(&settled.unit);
        Some(settled)
    }
}

/// The stored call `item` closed with the result `update` carries, as a page merges its stored result
/// ([`super::seams::merge_update`]); what `update` states of the live card alone is not the record's.
fn closed_with(item: &mut ThreadItem, update: &ThreadItem) {
    let mut closed = super::seams::merge_update(item, update);
    if let (ThreadItem::ToolCall { run: stored, .. }, ThreadItem::ToolCall { run, .. }) = (&*item, &mut closed) {
        run.live = stored.live;
        run.started_at = stored.started_at;
    }
    *item = closed;
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
    let page = reads::transcript_units(&deps.store, &deps.transcript, deps.lanes, id, at, records.min(MAX_RECORDS), ctl)
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

/// Worst-case UUID epoch string (36 ASCII bytes) for sizing `thread/window/changed` frames before the fence is minted.
const WORST_CASE_EPOCH: &str = "00000000-0000-0000-0000-000000000000";

fn units_json_bytes(units: &[StoredUnit]) -> usize {
    units.iter().map(|unit| unit.bytes).sum::<usize>() + units.len().saturating_sub(1)
}

fn preview_changed_params(id: &ThreadId, params: &ThreadWindowSetParams, held: &Grant, demand: &Demand, include_units: bool) -> ThreadWindowChangedParams {
    let ranges: Vec<GrantRange> = demand.ranges.iter().map(|wanted| wanted.range.clone()).collect();
    let removed = held.ranges.iter().filter(|old| !ranges.iter().any(|range| range.id == old.id)).map(|old| old.id.to_string()).collect();
    let added = demand
        .ranges
        .iter()
        .filter_map(|wanted| {
            let units = wanted.units.as_ref()?;
            Some(WindowAdded {
                range: wanted.range.id.to_string(),
                units: if include_units { units.iter().map(|unit| unit.unit.clone()).collect() } else { Vec::new() },
            })
        })
        .collect();
    ThreadWindowChangedParams {
        thread_id: id.clone(),
        subscription_id: params.subscription_id.clone(),
        request_id: Some(params.request_id.clone()),
        window_version: u64::MAX,
        lineage: held.lineage,
        at_feed_position: mixdog_app_protocol::v2::feed::FeedPosition { epoch: FeedEpoch::from(WORST_CASE_EPOCH), seq: u64::MAX },
        ranges: wire_ranges(&ranges),
        removed,
        added,
        follow_tail: demand.tail_from.is_some(),
    }
}

fn preview_frame_len(id: &ThreadId, params: &ThreadWindowSetParams, held: &Grant, feed_id: &FeedId, demand: &Demand, include_units: bool) -> usize {
    let preview = preview_changed_params(id, params, held, demand, include_units);
    let epoch = FeedEpoch::from(WORST_CASE_EPOCH);
    super::frames::frame(&super::frames::Note::new(WINDOW_CHANGED, &preview), feed_id, &epoch, u64::MAX).len()
}

fn drop_one_unit(wanted: &mut Wanted) -> bool {
    let Some(units) = wanted.units.as_mut() else { return false };
    let (cut_older, cut_newer) = if wanted.keep > 0 {
        units.remove(0);
        wanted.keep -= 1;
        (true, false)
    } else if units.len() > 1 {
        units.pop();
        (false, true)
    } else {
        return false;
    };
    let (reaches_start, reaches_end) = (wanted.range.older.is_none() && !cut_older, wanted.range.newer.is_none() && !cut_newer);
    if let Some(range) = range_of(&wanted.range.id, units, reaches_start, reaches_end) {
        wanted.range = range;
    }
    true
}

fn optional_units_bytes(units: &[StoredUnit], keep: usize) -> usize {
    units.get(keep).map_or(0, |anchor| units_json_bytes(units).saturating_sub(anchor.bytes))
}

/// The newly held units, cut to what one `thread/window/changed` frame of `budget` bytes delivers: whole units are
/// dropped from a range's far ends, never the record it was asked at, and the range then says where it continues.
/// Accounts for the exact serialized frame envelope (including `request_id`, `thread_id`, `subscription_id`, `ranges`,
/// `removed`, and feed metadata), reserves every range's mandatory anchor first so an earlier range's optional units
/// never starve a later range's anchor, and verifies the final serialized frame fits `<= budget`.
pub(crate) fn fit_demand(
    id: &ThreadId,
    params: &ThreadWindowSetParams,
    held: &Grant,
    feed_id: &FeedId,
    demand: &mut Demand,
    budget: usize,
) -> Result<(), CoreError> {
    let base_envelope = preview_frame_len(id, params, held, feed_id, demand, false);
    // Pass 1: reserve every range's mandatory anchor unit + envelope bytes before allocating optional units.
    let required_anchor_bytes: usize =
        demand.ranges.iter().filter_map(|wanted| wanted.units.as_ref().and_then(|units| units.get(wanted.keep))).map(|unit| unit.bytes).sum();
    let mut optional_room = budget.saturating_sub(base_envelope.saturating_add(required_anchor_bytes));
    // Pass 2: allocate remaining room to optional units across ranges, keeping every range's anchor intact.
    for wanted in demand.ranges.iter_mut() {
        let Some(units) = wanted.units.as_mut() else { continue };
        let (mut cut_older, mut cut_newer) = (false, false);
        while optional_units_bytes(units, wanted.keep) > optional_room {
            if wanted.keep > 0 {
                units.remove(0);
                wanted.keep -= 1;
                cut_older = true;
            } else if units.len() > 1 {
                units.pop();
                cut_newer = true;
            } else {
                break;
            }
        }
        optional_room = optional_room.saturating_sub(optional_units_bytes(units, wanted.keep));
        let (reaches_start, reaches_end) = (wanted.range.older.is_none() && !cut_older, wanted.range.newer.is_none() && !cut_newer);
        if let Some(range) = range_of(&wanted.range.id, units, reaches_start, reaches_end) {
            wanted.range = range;
        }
    }
    // Pass 3: enforce the exact serialized frame length against `budget` after continuation edges settle.
    while preview_frame_len(id, params, held, feed_id, demand, true) > budget {
        if !demand.ranges.iter_mut().rev().any(drop_one_unit) {
            return Err(invalid("want", "ranges whose records fit one window change"));
        }
    }
    Ok(())
}

/// The ranges `want` asks for, with the contents of those `held` does not hold, all from this one read. `calls`: the
/// running turns' calls as they stood when the read began; the units are fitted as they show them.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn demand(
    deps: &SessionDeps,
    id: &ThreadId,
    held: &Grant,
    params: &ThreadWindowSetParams,
    feed_id: &FeedId,
    calls: &Calls,
    budget: usize,
    ctl: &ReadCtl,
) -> Result<Demand, CoreError> {
    let lineage = held.lineage;
    let request = params.request_id.as_str();
    let want = &params.want;
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
    for unit in ranges.iter_mut().filter_map(|wanted| wanted.units.as_mut()).flatten() {
        if let Some(settled) = calls.settled(unit) {
            *unit = settled;
        }
    }
    let mut demand = Demand { ranges, tail_from };
    fit_demand(id, params, held, feed_id, &mut demand, budget)?;
    Ok(demand)
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
        deps.store.unheld(&self.id).await;
        let (store, thread, shown) = (deps.store.clone(), self.id.clone(), shown.to_owned());
        let found = mixdog_core_base::support::on_lane_wait(deps.lanes.io, cancel, move |lane| store.rewind_target(lane, &thread, &shown)).await??;
        let Some(stored) = found else { return Ok(None) };
        let previous = match stored.previous.clone() {
            Some(record) => {
                // The record as a page of the log reads it, with where its turn stores its end: a message of a turn
                // whose end is a record of its own shows none. The row a client holds last: a user row shows its
                // submission id.
                let trace = super::read_trace::ReadTrace::begin("thread/rewind/previous", self.id.as_str(), "record".to_owned());
                let ctl = ReadCtl { cancel: cancel.clone(), trace };
                let at = PageAt::Before(reads::record_position(record.iid.as_str()));
                match reads::page(&deps.store, &deps.transcript, deps.lanes, &self.id, at, 0, &ctl).await? {
                    Some(page) => page.rows[page.named_rows.clone()].last().map(|(item, _)| super::transcript::displayed_id(item).to_owned()),
                    // A store that places no page marks no turn's end either.
                    None => {
                        let transcript = deps.transcript.clone();
                        mixdog_core_base::support::on_lane_wait(deps.lanes.cpu, cancel, move |lane| {
                            transcript.rows(lane, &record).last().map(|(item, _)| super::transcript::displayed_id(item).to_owned())
                        })
                        .await?
                    }
                }
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
        deps.store.unheld(&self.id).await;
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

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::v2::thread::TranscriptUnit;
    use mixdog_protocol::{ItemId, ItemMeta, ThreadItem, ToolRun};
    use serde_json::json;

    use super::*;

    fn tool_unit(ordinal: u64, id: &str, call_id: &str) -> StoredUnit {
        let item = ThreadItem::ToolCall {
            id: ItemId::from(id),
            name: "read".into(),
            input: json!({ "file_path": "a.rs" }),
            output: None,
            run: Box::new(ToolRun { call_id: Some(call_id.into()), started_at: Some(1_000), ..ToolRun::default() }),
            meta: ItemMeta { at: Some(1_000), ..ItemMeta::default() },
        };
        let unit = TranscriptUnit { position: format!("h1:0:r{ordinal}"), items: vec![item], ordinal: Some(ordinal) };
        let bytes = reads::unit_bytes(&unit);
        StoredUnit { ordinal, unit, bytes }
    }

    fn test_params(request_id: String) -> ThreadWindowSetParams {
        ThreadWindowSetParams {
            thread_id: ThreadId::from("thr_window_fit"),
            subscription_id: mixdog_protocol::SubscriptionId::from("sub_window_fit"),
            request_id,
            base_window_version: 1,
            want: mixdog_app_protocol::v2::thread::WindowWant { ranges: Vec::new(), pinned: Vec::new(), follow_tail: false },
        }
    }

    #[test]
    fn window_fit_refits_after_long_provisional_id_substitution_within_frame_budget() {
        let mut older = tool_unit(1, "r1", "c1");
        if let ThreadItem::ToolCall { input, .. } = &mut older.unit.items[0] {
            *input = json!({ "file_path": "o".repeat(1_024) });
        }
        older.bytes = reads::unit_bytes(&older.unit);
        let anchor = tool_unit(2, "r2", "c2");
        let range = range_of("q:req:0", &[older.clone(), anchor.clone()], true, true).expect("range");
        let params = test_params("req".into());
        let held = Grant { version: 1, lineage: 1, ranges: Vec::new(), tail_from: None };
        let feed_id = FeedId::from("feed_window_fit");
        let mut demand = Demand { ranges: vec![Wanted { range, units: Some(vec![older, anchor]), keep: 1 }], tail_from: None };
        let initial_frame = preview_frame_len(&params.thread_id, &params, &held, &feed_id, &demand, true);
        // Budget fits both units before substituting a long opaque provisional call id onto the anchor.
        let budget = initial_frame + 32;
        fit_demand(&params.thread_id, &params, &held, &feed_id, &mut demand, budget).expect("initial fit succeeds with both units");
        assert_eq!(demand.ranges[0].units.as_ref().map(Vec::len), Some(2));

        // Substituting a long opaque `call:*` id grows the anchor past the remaining slack.
        let long_id = format!("call:{}", "x".repeat(512));
        let anchor_unit = &mut demand.ranges[0].units.as_mut().unwrap()[1];
        if let ThreadItem::ToolCall { id, .. } = &mut anchor_unit.unit.items[0] {
            *id = ItemId::from(long_id.as_str());
        }
        anchor_unit.bytes = reads::unit_bytes(&anchor_unit.unit);
        assert!(
            preview_frame_len(&params.thread_id, &params, &held, &feed_id, &demand, true) > budget,
            "substituted long opaque id must exceed pre-refit budget"
        );

        fit_demand(&params.thread_id, &params, &held, &feed_id, &mut demand, budget).expect("refit trims older non-anchor unit instead of exceeding budget");
        let kept = demand.ranges[0].units.as_ref().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].ordinal, 2);
        assert!(preview_frame_len(&params.thread_id, &params, &held, &feed_id, &demand, true) <= budget);
        assert!(demand.ranges[0].range.older.is_some(), "dropped older unit must expose continuation edge");
    }

    #[test]
    fn window_fit_refits_exact_envelope_with_7k_request_id_and_46k_unit_under_64k_budget() {
        let budget = 64 << 10;
        let big_request_id = "r".repeat(7 * 1024);
        let range_id = format!("q:{big_request_id}:0");
        let params = test_params(big_request_id);
        let held = Grant { version: 1, lineage: 1, ranges: Vec::new(), tail_from: None };
        let feed_id = FeedId::from("feed_window_7k");

        let make_sized = |ordinal: u64, payload_len: usize| {
            let item = ThreadItem::ToolCall {
                id: ItemId::from(format!("call:synth_{ordinal}")),
                name: "read".into(),
                input: json!({ "payload": "p".repeat(payload_len) }),
                output: None,
                run: Box::new(ToolRun { call_id: Some(format!("c_{ordinal}")), started_at: Some(1_000), ..ToolRun::default() }),
                meta: ItemMeta { at: Some(1_000), ..ItemMeta::default() },
            };
            let unit = TranscriptUnit { position: format!("h1:0:r{ordinal}"), items: vec![item], ordinal: Some(ordinal) };
            let bytes = reads::unit_bytes(&unit);
            StoredUnit { ordinal, unit, bytes }
        };

        // Case 1: 7 KiB request_id (appearing in requestId, ranges[0].id, and added[0].range = ~21 KiB envelope!)
        // + 46 KiB single anchor > 64 KiB budget -> must be refused instead of emitting an oversized frame.
        let anchor_46k = make_sized(2, 46 * 1024);
        let single_range = range_of(&range_id, &[anchor_46k.clone()], true, true).expect("range");
        let mut oversized = Demand { ranges: vec![Wanted { range: single_range, units: Some(vec![anchor_46k]), keep: 0 }], tail_from: None };
        assert!(
            fit_demand(&params.thread_id, &params, &held, &feed_id, &mut oversized, budget).is_err(),
            "46 KiB anchor plus ~21 KiB requestId envelope must be refused under 64 KiB budget"
        );

        // Case 2: 7 KiB request_id (~21 KiB envelope) + 12 KiB older + 36 KiB anchor:
        // together (~69 KiB) they exceed 64 KiB, so fit_demand trims older and emits a frame strictly <= 64 KiB.
        let older_12k = make_sized(1, 12 * 1024);
        let anchor_36k = make_sized(2, 36 * 1024);
        let multi_range = range_of(&range_id, &[older_12k.clone(), anchor_36k.clone()], true, true).expect("range");
        let mut demand = Demand { ranges: vec![Wanted { range: multi_range, units: Some(vec![older_12k, anchor_36k]), keep: 1 }], tail_from: None };
        fit_demand(&params.thread_id, &params, &held, &feed_id, &mut demand, budget).expect("multi-unit demand trims to fit 64 KiB");
        assert_eq!(demand.ranges[0].units.as_ref().map(Vec::len), Some(1));
        assert_eq!(demand.ranges[0].units.as_ref().unwrap()[0].ordinal, 2);
        let actual_frame = super::super::frames::frame(
            &super::super::frames::Note::new(
                WINDOW_CHANGED,
                &changed(
                    &params.thread_id,
                    &params,
                    &held,
                    demand,
                    2,
                    &mixdog_core_api::feed::FeedPosition { epoch: FeedEpoch::from(WORST_CASE_EPOCH), seq: 42 },
                ),
            ),
            &feed_id,
            &FeedEpoch::from(WORST_CASE_EPOCH),
            42,
        );
        assert!(actual_frame.len() <= budget, "emitted frame ({} bytes) must stay <= {budget}", actual_frame.len());
    }

    #[test]
    fn window_fit_reserves_all_anchors_before_earlier_range_optional_units() {
        let budget = 64 << 10;
        let params = test_params("req_multi_range".into());
        let held = Grant { version: 1, lineage: 1, ranges: Vec::new(), tail_from: None };
        let feed_id = FeedId::from("feed_multi_range");

        let make_sized = |ordinal: u64, payload_len: usize| {
            let item = ThreadItem::ToolCall {
                id: ItemId::from(format!("call:synth_{ordinal}")),
                name: "read".into(),
                input: json!({ "payload": "p".repeat(payload_len) }),
                output: None,
                run: Box::new(ToolRun { call_id: Some(format!("c_{ordinal}")), started_at: Some(1_000), ..ToolRun::default() }),
                meta: ItemMeta { at: Some(1_000), ..ItemMeta::default() },
            };
            let unit = TranscriptUnit { position: format!("h1:0:r{ordinal}"), items: vec![item], ordinal: Some(ordinal) };
            let bytes = reads::unit_bytes(&unit);
            StoredUnit { ordinal, unit, bytes }
        };

        let r1_optional_45k = make_sized(1, 45 * 1024);
        let r1_anchor_5k = make_sized(2, 5 * 1024);
        let r2_anchor_20k = make_sized(3, 20 * 1024);

        let range1 = range_of("q:req_multi_range:0", &[r1_optional_45k.clone(), r1_anchor_5k.clone()], true, true).expect("range1");
        let range2 = range_of("q:req_multi_range:1", &[r2_anchor_20k.clone()], true, true).expect("range2");
        let mut demand = Demand {
            ranges: vec![
                Wanted { range: range1, units: Some(vec![r1_optional_45k, r1_anchor_5k]), keep: 1 },
                Wanted { range: range2, units: Some(vec![r2_anchor_20k]), keep: 0 },
            ],
            tail_from: None,
        };

        fit_demand(&params.thread_id, &params, &held, &feed_id, &mut demand, budget).expect("earlier range optional unit must not starve later range anchor");

        let kept1 = demand.ranges[0].units.as_ref().unwrap();
        let kept2 = demand.ranges[1].units.as_ref().unwrap();
        assert_eq!(kept1.len(), 1);
        assert_eq!(kept1[0].ordinal, 2);
        assert!(demand.ranges[0].range.older.is_some(), "dropped 45 KiB optional unit must expose continuation edge");
        assert_eq!(kept2.len(), 1);
        assert_eq!(kept2[0].ordinal, 3);

        let actual_frame = super::super::frames::frame(
            &super::super::frames::Note::new(
                WINDOW_CHANGED,
                &changed(
                    &params.thread_id,
                    &params,
                    &held,
                    demand,
                    2,
                    &mixdog_core_api::feed::FeedPosition { epoch: FeedEpoch::from(WORST_CASE_EPOCH), seq: 42 },
                ),
            ),
            &feed_id,
            &FeedEpoch::from(WORST_CASE_EPOCH),
            42,
        );
        assert!(actual_frame.len() <= budget, "emitted frame ({} bytes) must stay <= {budget}", actual_frame.len());
    }
}
