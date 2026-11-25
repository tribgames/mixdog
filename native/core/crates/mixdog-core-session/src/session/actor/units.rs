//! The stored records as the positioned subscriptions hold them.
//!
//! The session log is what a positioned subscription holds a projection of: each occurrence of the transcript (a
//! record that shows rows, a compaction's divider) is one unit at its own ordinal, the same in a snapshot, in a range
//! asked for and live ([`reads::transcript_units`]). A record new to the log is sent as its unit from the commit the
//! store acknowledged, with the rows that commit projected ([`UnitJob::Unit`]): nothing is read for it, its
//! predecessor included. Only what changes how an occurrence already stored reads is read again (an amend, a call's
//! result, the rows a compaction archived, a model switch on a divider).
//!
//! The actor keeps one line of these ([`UnitJob`]), run one at a time in the order they were asked: a committed unit
//! sent ([`Feed::deliver`], by each subscription's grant alone, with the tail a snapshot carries in the same step), an
//! occurrence read again, the newest records a snapshot carries, and a subscription's demand
//! ([`super::super::window`]). Because a demand is read in that line, the grant it makes is exactly the rows it
//! carries: a unit committed before the read is in it, one committed after is sent behind its fence, never both as
//! two occurrences. A read that fails is not tried again: its demand fails, and for an occurrence read again every
//! subscription is left holding nothing from its last fence on ([`SessionActor::unread`]), so none is sent a later
//! change across the hole.
//!
//! A call of a running turn reads in every one of them as the session holds it ([`window::Calls`]), and each change
//! of it (its result shown ahead of its row, its result stored, its turn ended without one) is a read of the record
//! that made it in the line: a demand shows the calls as they stood when its read began, and a later change follows
//! its fence.

use mixdog_app_protocol::v2::thread::ThreadWindowSetParams;
use mixdog_app_protocol::v2::thread::ThreadWindowSetResponse;
use mixdog_app_protocol::v2::thread::TranscriptChange;
use mixdog_core_api::feed::Grant;
use mixdog_core_api::feed::GrantAsk;
use mixdog_core_api::feed::Held;

use super::super::read_trace::ReadCtl;
use super::super::read_trace::ReadTrace;
use super::super::reads;
use super::super::reads::StoredUnit;
use super::super::seams::PageAt;
use super::super::window;
use super::*;

/// One read of the line.
pub(in crate::session) enum UnitJob {
    /// An occurrence the store acknowledged, as its commit projected it: sent to the subscriptions that hold it,
    /// with no read.
    Unit(Box<StoredUnit>),
    /// The stored record `iid`, read again and sent to the subscriptions that hold it.
    Record(String),
    /// Every range a subscription holds, read again: a change reached records the actor cannot name (a compaction's
    /// archived rows and its divider, a model switch on a divider).
    Held,
    /// The newest stored records: what a positioned snapshot carries.
    Tail,
    /// A subscription's demand.
    Demand(Box<WindowAsk>),
    /// Answered when its turn comes: every read asked before it is done, and a snapshot attached from then on carries
    /// the records they read. With the failure, when the newest records were not read.
    Ready(oneshot::Sender<Result<(), CoreError>>),
    /// A place in the line that what is released next waits for: behind a compaction's divider, and where the line
    /// stood when a turn's terminal record was held for it, whatever was asked of the line since.
    Closing,
}

pub(in crate::session) struct WindowAsk {
    pub params: ThreadWindowSetParams,
    pub cancel: CancellationToken,
    pub tx: Waiter,
}

/// A stored record as read for the subscriptions that hold it.
pub(in crate::session) struct Reading {
    rev: u64,
    unit: StoredUnit,
    /// The position of the stored record shown before it, when the read found one.
    after: Option<String>,
    /// Records older than it are stored.
    older: bool,
}

/// What a job of the line read.
pub(in crate::session) enum UnitsRead {
    Record(Result<Option<Reading>, CoreError>),
    Held(Result<(u64, Vec<StoredUnit>), CoreError>),
    Tail(Result<Option<reads::Units>, CoreError>),
    Demand(Box<WindowAsk>, Box<Grant>, Result<window::Demand, CoreError>),
}

fn ctl(method: &'static str, thread: &ThreadId, shape: &str, cancel: CancellationToken) -> ReadCtl {
    ReadCtl { cancel, trace: ReadTrace::begin(method, thread.as_str(), shape.to_owned()) }
}

async fn read_record(deps: &SessionDeps, id: &ThreadId, iid: &str) -> Result<Option<Reading>, CoreError> {
    let ctl = ctl("thread/transcript/unit", id, "record", CancellationToken::new());
    let position = reads::record_position(iid);
    // The record, with the few before it: the one shown before it is where a follower of the tail places it.
    let read = reads::transcript_units(&deps.store, &deps.transcript, deps.lanes, id, PageAt::Before(position.clone()), 4, &ctl);
    let Some(page) = read.await? else { return Ok(None) };
    let Some(at) = page.units.iter().position(|unit| unit.unit.position == position) else { return Ok(None) };
    let after = at.checked_sub(1).map(|before| page.units[before].unit.position.clone());
    let older = after.is_some() || !page.reaches_start;
    Ok(Some(Reading { rev: page.rev, unit: page.units[at].clone(), after, older }))
}

/// The records of each span (the position of its first record, the ordinal of its last), oldest first.
async fn read_held(deps: &SessionDeps, id: &ThreadId, spans: Vec<(Arc<str>, u64)>) -> Result<(u64, Vec<StoredUnit>), CoreError> {
    const PAGE: usize = 64;
    let ctl = ctl("thread/transcript/unit", id, "held", CancellationToken::new());
    let (mut rev, mut units): (u64, Vec<StoredUnit>) = (0, Vec::new());
    for (from, last) in spans {
        let mut at = from.to_string();
        let mut through = None;
        loop {
            let read = reads::transcript_units(&deps.store, &deps.transcript, deps.lanes, id, PageAt::After(at.clone()), PAGE, &ctl);
            let Some(page) = read.await? else { break };
            rev = page.rev;
            let fresh: Vec<StoredUnit> =
                page.units.into_iter().filter(|unit| through.is_none_or(|through| unit.ordinal > through) && unit.ordinal <= last).collect();
            let Some(newest) = fresh.last() else { break };
            (at, through) = (newest.unit.position.clone(), Some(newest.ordinal));
            units.extend(fresh);
            if page.reaches_end || through.is_some_and(|through| through >= last) {
                break;
            }
        }
    }
    Ok((rev, units))
}

fn sized(ordinal: u64, position: String, items: Vec<ThreadItem>) -> StoredUnit {
    let unit = mixdog_app_protocol::v2::thread::TranscriptUnit { position, items, ordinal: Some(ordinal) };
    let bytes = serde_json::to_vec(&unit).map_or(0, |encoded| encoded.len());
    StoredUnit { ordinal, unit, bytes }
}

impl SessionActor {
    /// A record is stored at `ordinal`. An occurrence it adds to the transcript (`unit`: the rows its commit projected,
    /// or a compaction's divider) is sent as its unit to the positioned subscriptions whose grants hold it; the stored
    /// occurrences that read differently for it are read again.
    pub(super) fn stored(&mut self, change: &Change, unit: &[ThreadItem], ordinal: u64) {
        let Change::Record { record, display } = change else { return };
        match &**record {
            Record::Item(row) => {
                if let Some(turn) = self.running(row) {
                    if let Slot::Inline(body) = &row.body {
                        let made = body.get("toolCalls").and_then(Value::as_array).into_iter().flatten();
                        for call in made.filter_map(|call| call.get("id").and_then(Value::as_str)) {
                            Arc::make_mut(&mut self.calls).opened(call, turn, row.iid.as_str());
                        }
                    }
                    // A call's result is stored by a later record and shown on the card of the record that made the call.
                    if let Display::Items(shown) = display {
                        for shown in shown {
                            if let Shown::Update(update) = shown {
                                self.call_ended(turn, update, true);
                            }
                        }
                    }
                }
                // A row that is no message of a turn a compaction ran in reads archived or not by what the compaction
                // left of the turn, which the records tell: it is read, in its place in the line.
                let by_compaction = row.form == Form::Display && row.turn.as_ref().is_some_and(|turn| self.compacted.iter().any(|run| run == turn.as_str()));
                if !unit.is_empty() {
                    self.unit_job(if by_compaction {
                        UnitJob::Record(row.iid.as_str().to_owned())
                    } else {
                        UnitJob::Unit(Box::new(sized(ordinal, reads::record_position(row.iid.as_str()), unit.to_vec())))
                    });
                }
            }
            Record::Run(run) if matches!(run.phase, RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted) => {
                self.compacted.retain(|turn| turn != run.rid.as_str());
                if !self.calls.is_empty() {
                    for record in Arc::make_mut(&mut self.calls).turn_ended(run.rid.as_str()) {
                        self.unit_job(UnitJob::Record(record));
                    }
                }
            }
            Record::Amend(amend) => self.unit_job(UnitJob::Record(amend.iid.as_str().to_owned())),
            Record::Compacted(compacted) => {
                // The divider is an occurrence of its own at the compaction's record, sent before anything committed
                // after it; a rewrite that lists none adds no occurrence.
                if compacted.silent != Some(true) {
                    let divider = super::super::transcript::divider_item(compacted.cid.as_str(), compacted.at);
                    let position = reads::record_position(divider.id().as_str());
                    self.unit_job(UnitJob::Unit(Box::new(sized(ordinal, position, vec![divider]))));
                    // Nothing released after the compaction's record goes out before its divider.
                    self.closing_pending += 1;
                    self.unit_job(UnitJob::Closing);
                }
                for turn in self.acked.runs.keys() {
                    if !self.compacted.contains(turn) {
                        self.compacted.push(turn.clone());
                    }
                }
                // The rows it took out of the context read `archived` from here on.
                self.unit_job(UnitJob::Tail);
                self.unit_job(UnitJob::Held);
            }
            Record::ModelSwitch(_) => {
                self.unit_job(UnitJob::Tail);
                self.unit_job(UnitJob::Held);
            }
            Record::Rewind(_) => {
                if !self.calls.is_empty() {
                    Arc::make_mut(&mut self.calls).reread();
                }
                self.unit_job(UnitJob::Tail);
            }
            _ => {}
        }
    }

    /// The turn of `row`, when the released entries tell it running: its calls are held ([`window::Calls`]) until it
    /// ends.
    pub(super) fn running<'a>(&self, row: &'a ItemRecord) -> Option<&'a str> {
        row.turn.as_ref().map(|turn| turn.as_str()).filter(|turn| self.acked.runs.contains_key(*turn))
    }

    /// A call of the running turn `turn` ended with the result `update` carries (`stored`: by its stored row, else
    /// shown ahead of it): the record that made it is read again, for the subscriptions that hold it.
    pub(super) fn call_ended(&mut self, turn: &str, update: &ThreadItem, stored: bool) {
        let ThreadItem::ToolCall { run, .. } = update else { return };
        let Some(call) = run.call_id.as_deref() else { return };
        if let Some(record) = Arc::make_mut(&mut self.calls).ended(call, turn, update, stored) {
            self.unit_job(UnitJob::Record(record));
        }
    }

    pub(super) fn unit_job(&mut self, job: UnitJob) {
        // A newer demand of a subscription stands: an earlier one not yet read answers nothing.
        if let UnitJob::Demand(ask) = &job {
            let sub = ask.params.subscription_id.clone();
            let (superseded, kept): (Vec<UnitJob>, Vec<UnitJob>) = std::mem::take(&mut self.unit_jobs)
                .into_iter()
                .partition(|queued| matches!(queued, UnitJob::Demand(queued) if queued.params.subscription_id == sub));
            self.unit_jobs = kept.into();
            for queued in superseded {
                if let UnitJob::Demand(queued) = queued {
                    let _ = queued.tx.send(Err(CoreError::Cancelled { by: "superseded".into() }));
                }
            }
        }
        self.unit_jobs.push_back(job);
        self.next_unit_job();
    }

    /// A job of the line is reading or waits to run.
    pub(super) fn line_busy(&self) -> bool {
        self.unit_reading || !self.unit_jobs.is_empty()
    }

    pub(super) fn next_unit_job(&mut self) {
        // A unit goes out behind the frames of the release that stored its record, which are published once that
        // release is whole: a snapshot taken with it then states the feed position it stands at.
        while !self.unit_reading && !self.releasing {
            let Some(job) = self.unit_jobs.pop_front() else { return };
            let (deps, id, jobs) = (self.deps.clone(), self.id.clone(), self.jobs_tx.clone());
            match job {
                UnitJob::Ready(tx) => {
                    let _ = tx.send(self.tail_unread.clone().map_or(Ok(()), Err));
                }
                UnitJob::Closing => self.closing_pending = self.closing_pending.saturating_sub(1),
                UnitJob::Unit(unit) => {
                    // The record before it is the newest the tail holds: known here, with no read.
                    let before = self.tail.iter().rev().find(|held| held.ordinal < unit.ordinal).map(|held| held.unit.position.clone());
                    let older = before.is_some() || self.tail_older;
                    self.deliver_unit(self.acked.history_rev, *unit, before, older);
                }
                UnitJob::Record(iid) => {
                    self.unit_reading = true;
                    tokio::spawn(async move {
                        let read = read_record(&deps, &id, &iid).await;
                        let _ = jobs.send(JobDone::UnitsRead(Box::new(UnitsRead::Record(read))));
                    });
                }
                UnitJob::Held => {
                    // Ranges that overlap are read once.
                    let mut spans: Vec<(u64, Arc<str>, u64)> = self
                        .feed
                        .held(self.acked.history_rev)
                        .into_iter()
                        .filter(|range| !range.from.is_empty())
                        .map(|range| (range.first, range.from, range.last))
                        .collect();
                    spans.sort_by_key(|(first, _, last)| (*first, *last));
                    let mut merged: Vec<(u64, Arc<str>, u64)> = Vec::new();
                    for span in spans {
                        match merged.last_mut() {
                            Some(last) if span.0 <= last.2 => last.2 = last.2.max(span.2),
                            _ => merged.push(span),
                        }
                    }
                    if merged.is_empty() {
                        continue;
                    }
                    self.unit_reading = true;
                    tokio::spawn(async move {
                        let spans = merged.into_iter().map(|(_, from, last)| (from, last)).collect();
                        let read = read_held(&deps, &id, spans).await;
                        let _ = jobs.send(JobDone::UnitsRead(Box::new(UnitsRead::Held(read))));
                    });
                }
                UnitJob::Tail => {
                    self.unit_reading = true;
                    tokio::spawn(async move {
                        let ctl = ctl("thread/transcript/unit", &id, "tail", CancellationToken::new());
                        let read = reads::transcript_units(&deps.store, &deps.transcript, deps.lanes, &id, PageAt::Newest, window::TAIL_RECORDS, &ctl).await;
                        let _ = jobs.send(JobDone::UnitsRead(Box::new(UnitsRead::Tail(read))));
                    });
                }
                UnitJob::Demand(ask) => {
                    let sub = mixdog_core_api::ids::SubscriptionId::from(ask.params.subscription_id.as_str());
                    let Some(held) = self.feed.grant(&sub) else {
                        let _ = ask.tx.send(Err(CoreError::ConnectionClosed));
                        continue;
                    };
                    if held.version != ask.params.base_window_version {
                        let _ = ask.tx.send(Err(window::other_version(ask.params.base_window_version, held.version.to_string())));
                        continue;
                    }
                    self.unit_reading = true;
                    let (budget, calls) = (self.feed.frame_budget(), self.calls.clone());
                    tokio::spawn(async move {
                        let ctl = ctl("thread/window/set", &id, &ask.params.request_id, ask.cancel.clone());
                        let read = window::demand(&deps, &id, &held, &ask.params.request_id, &ask.params.want, &calls, budget, &ctl).await;
                        let _ = jobs.send(JobDone::UnitsRead(Box::new(UnitsRead::Demand(ask, Box::new(held), read))));
                    });
                }
            }
        }
    }

    pub(super) fn units_read(&mut self, read: UnitsRead) {
        self.unit_reading = false;
        match read {
            UnitsRead::Record(Ok(Some(reading))) => self.deliver_unit(reading.rev, reading.unit, reading.after, reading.older),
            UnitsRead::Record(Ok(None)) => {}
            UnitsRead::Record(Err(error)) => self.unread("a stored record", error),
            UnitsRead::Held(Ok((rev, units))) => {
                for unit in units {
                    self.deliver_unit(rev, unit, None, true);
                }
            }
            UnitsRead::Held(Err(error)) => self.unread("a held range", error),
            UnitsRead::Tail(Ok(read)) => self.tail_read(read),
            UnitsRead::Tail(Err(error)) => self.unread("the newest records", error),
            UnitsRead::Demand(ask, held, read) => {
                let WindowAsk { params, tx, .. } = *ask;
                let _ = tx.send(read.and_then(|demand| self.install_demand(&params, &held, demand)));
            }
        }
        self.next_unit_job();
    }

    /// `unit` with the calls of the running turns as the session holds them ([`window::Calls`]): the unit itself when
    /// it shows none.
    pub(super) fn settled_unit(&self, unit: &Arc<StoredUnit>) -> Arc<StoredUnit> {
        self.calls.settled(unit).map_or_else(|| unit.clone(), Arc::new)
    }

    /// The stored record as it reads now: to the snapshot's tail when it belongs there, and to every positioned
    /// subscription whose grant holds it, in one step with the view that carries it.
    fn deliver_unit(&mut self, rev: u64, unit: StoredUnit, after: Option<String>, older: bool) {
        let lineage = self.acked.history_rev;
        // A read of a history revision that is gone tells nothing of this one.
        if rev != lineage {
            return;
        }
        if !self.calls.is_empty() {
            Arc::make_mut(&mut self.calls).read(&unit);
        }
        let unit = Arc::new(unit);
        match self.tail.iter().position(|held| held.ordinal >= unit.ordinal) {
            Some(at) if self.tail[at].ordinal == unit.ordinal => self.tail[at] = unit.clone(),
            // Older than everything the tail holds: a page of it shows it.
            Some(0) => {}
            Some(at) => self.tail.insert(at, unit.clone()),
            // Read again where the tail no longer reaches (it was let go after a read failed): a page of it shows it.
            None if unit.ordinal < self.tail_next => {}
            None => {
                self.tail.push(unit.clone());
                if self.tail.len() > window::TAIL_RECORDS {
                    self.tail.remove(0);
                    self.tail_older = true;
                }
            }
        }
        self.tail_next = self.tail_next.max(unit.ordinal + 1);
        let view = self.swap_view();
        let unit = self.settled_unit(&unit);
        let (thread, feed) = (self.id.clone(), self.feed_id.clone());
        let after = after.or_else(|| older.then(String::new));
        self.feed.deliver(lineage, unit.ordinal, &unit.unit.position, after.as_deref(), Some(view), &mut |held, at| {
            let change = match held {
                Held::Tail => TranscriptChange::Insert { after: after.clone().filter(|after| !after.is_empty()), unit: unit.unit.clone() },
                Held::Range => TranscriptChange::Replace { unit: unit.unit.clone() },
            };
            super::super::frames::unit_frame(&thread, lineage, change, &feed, at)
        });
    }

    /// The newest stored records as read: what a positioned snapshot carries from here on.
    fn tail_read(&mut self, read: Option<reads::Units>) {
        if let Some(read) = read.filter(|read| read.rev == self.acked.history_rev) {
            self.tail_next = self.tail_next.max(read.units.last().map_or(0, |last| last.ordinal + 1));
            self.tail_older = !read.reaches_start;
            self.tail = read.units.into_iter().map(Arc::new).collect();
            self.tail_unread = None;
            let view = self.swap_view();
            // The actor is the feed's only producer.
            let _ = self.feed.publish(&[], Some(view));
        }
    }

    /// The view as it stands now, the cell's too: what the feed's next snapshot is encoded from.
    fn swap_view(&mut self) -> Arc<SessionView> {
        let view = Arc::new(self.view());
        self.cell.view.store(view.clone());
        self.deferred_frames = 0;
        self.view_built_ms = self.deps.clock.now_ms();
        view
    }

    /// The demand as read, installed at the feed's position now: its ranges are the grant, and its units are what the
    /// subscription is told with it.
    fn install_demand(&mut self, params: &ThreadWindowSetParams, held: &Grant, demand: window::Demand) -> Result<Reply, CoreError> {
        let sub = mixdog_core_api::ids::SubscriptionId::from(params.subscription_id.as_str());
        let ranges = demand.ranges.iter().map(|wanted| wanted.range.clone()).collect();
        let ask = GrantAsk { lineage: held.lineage, ranges, tail_from: demand.tail_from };
        // A grant another change made meanwhile (a lineage change, a recovery's snapshot) stands: this one is refused.
        let fence = self.feed.regrant(&sub, held.version, ask)?;
        let told = window::changed(&self.id, params, held, demand, fence.version, &fence.at);
        fence.slot.fill(super::super::frames::frame(&Note::new(window::WINDOW_CHANGED, &told), &self.feed_id, &fence.at.epoch, fence.at.seq));
        Ok(Reply::Value(serde_json::to_value(ThreadWindowSetResponse { request_id: params.request_id.clone() }).unwrap_or(Value::Null)))
    }

    /// Answers once the stored records asked for so far are read: a positioned subscription attached from then on is
    /// sent them in its snapshot. Newest records that were not read are this demand's to read, once: it fails with
    /// that read, and no snapshot is attached on a tail with a hole in it.
    pub(super) fn tail_ready(&mut self, tx: oneshot::Sender<Result<(), CoreError>>) {
        if self.tail_unread.is_some() && !self.unit_jobs.iter().any(|job| matches!(job, UnitJob::Tail)) {
            self.unit_job(UnitJob::Tail);
        }
        self.unit_job(UnitJob::Ready(tx));
    }

    /// A read of occurrences already stored failed, and is not tried again. What the positioned subscriptions hold of
    /// them is no longer known to be what the log says, so none of it is kept: each subscription holds nothing from its
    /// last fence on and is told so (it asks again for what it shows), the tail a snapshot carries is let go, and a
    /// snapshot is attached only once a read of the newest records succeeds.
    fn unread(&mut self, what: &str, error: CoreError) {
        tracing::warn!("session {}: {what} was not read, so the positioned subscriptions hold nothing until they ask again: {error:?}", self.id.as_str());
        if !self.calls.is_empty() {
            Arc::make_mut(&mut self.calls).reread();
        }
        self.tail.clear();
        self.tail_older = self.tail_next > 0;
        self.tail_unread = Some(error);
        let view = self.swap_view();
        // The actor is the feed's only producer.
        let _ = self.feed.publish(&[], Some(view));
        let lineage = self.acked.history_rev;
        self.feed.rebase(&mut |sub, held, version, at| {
            if held.ranges.is_empty() && held.tail_from.is_none() {
                return None;
            }
            let params = mixdog_app_protocol::v2::thread::ThreadWindowChangedParams {
                thread_id: self.id.clone(),
                subscription_id: mixdog_protocol::SubscriptionId::from(sub.as_str()),
                request_id: None,
                window_version: version,
                lineage,
                at_feed_position: mixdog_app_protocol::v2::feed::FeedPosition { epoch: at.epoch.clone(), seq: at.seq },
                ranges: Vec::new(),
                removed: held.ranges.iter().map(|range| range.id.to_string()).collect(),
                added: Vec::new(),
                follow_tail: false,
            };
            let told = super::super::frames::frame(&Note::new(window::WINDOW_CHANGED, &params), &self.feed_id, &at.epoch, at.seq);
            Some((GrantAsk { lineage, ranges: Vec::new(), tail_from: None }, told))
        });
    }
}
