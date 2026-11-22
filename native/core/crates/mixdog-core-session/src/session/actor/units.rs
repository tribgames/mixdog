//! The stored records as the positioned subscriptions hold them.
//!
//! A positioned subscription is sent a record's rows from one producer only, the stored page of that record
//! ([`reads::units`]): in its snapshot, in a range it asked for, and whenever the record is stored or then reads
//! differently. The actor keeps one line of reads ([`UnitJob`]), run one at a time in the order they were asked: a
//! record's unit read and sent ([`Feed::deliver`], by each subscription's grant alone), the ranges subscriptions hold
//! read again after a change that reaches many records, the newest records a snapshot carries, and a subscription's
//! demand ([`super::super::window`]). Because a demand is read in that line, the grant it makes is exactly the rows
//! it carries: a unit stored before the read is in it, one stored after is sent behind its fence.

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
    /// The stored record `iid`, sent to the subscriptions that hold it.
    Record(String),
    /// Every range a subscription holds, read again: a change reached records the actor cannot name (a compaction's
    /// archived rows and its divider, a model switch on a divider).
    Held,
    /// The newest stored records: what a positioned snapshot carries.
    Tail,
    /// A subscription's demand.
    Demand(Box<WindowAsk>),
    /// Answered when its turn comes: every read asked before it is done, and a snapshot attached from then on carries
    /// the records they read.
    Ready(oneshot::Sender<()>),
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
    Record(Option<Reading>),
    Held(u64, Vec<StoredUnit>),
    Tail(Option<reads::Units>),
    Demand(Box<WindowAsk>, Box<Grant>, Result<window::Demand, CoreError>),
}

fn ctl(method: &'static str, thread: &ThreadId, shape: &str, cancel: CancellationToken) -> ReadCtl {
    ReadCtl { cancel, trace: ReadTrace::begin(method, thread.as_str(), shape.to_owned()) }
}

async fn read_record(deps: &SessionDeps, id: &ThreadId, iid: &str) -> Result<Option<Reading>, CoreError> {
    let ctl = ctl("thread/transcript/unit", id, "record", CancellationToken::new());
    let position = reads::record_position(iid);
    // The record, with the few before it: the one shown before it is where a follower of the tail places it.
    let Some(page) = reads::units(&deps.store, &deps.transcript, deps.lanes, id, PageAt::Before(position.clone()), 4, &ctl).await? else { return Ok(None) };
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
            let Some(page) = reads::units(&deps.store, &deps.transcript, deps.lanes, id, PageAt::After(at.clone()), PAGE, &ctl).await? else { break };
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

fn unread(id: &ThreadId, what: &str, error: &CoreError) {
    tracing::warn!("session {}: {what} was not read, so a subscription that holds it shows it as it was: {error:?}", id.as_str());
}

impl SessionActor {
    /// A record is stored: the stored records that read differently for it are read again, each sent as its unit to the
    /// positioned subscriptions whose grants hold it.
    pub(super) fn stored(&mut self, change: &Change) {
        let Change::Record { record, .. } = change else { return };
        match &**record {
            Record::Item(row) => {
                if let Slot::Inline(body) = &row.body {
                    // A call's result is stored by a later record and shown on the card of the record that made the call.
                    for call in body.get("toolCalls").and_then(Value::as_array).into_iter().flatten().filter_map(|call| call.get("id").and_then(Value::as_str))
                    {
                        if self.call_records.len() >= CALL_RECORDS {
                            self.call_records.clear();
                        }
                        self.call_records.insert(call.to_owned(), row.iid.as_str().to_owned());
                    }
                    if let Some(owner) = body.get("toolCallId").and_then(Value::as_str).and_then(|call| self.call_records.remove(call)) {
                        self.unit_job(UnitJob::Record(owner));
                    }
                }
                if row.visible {
                    self.unit_job(UnitJob::Record(row.iid.as_str().to_owned()));
                }
            }
            Record::Amend(amend) => self.unit_job(UnitJob::Record(amend.iid.as_str().to_owned())),
            Record::Compacted(_) | Record::ModelSwitch(_) => {
                self.unit_job(UnitJob::Tail);
                self.unit_job(UnitJob::Held);
            }
            Record::Rewind(_) => self.unit_job(UnitJob::Tail),
            _ => {}
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

    fn next_unit_job(&mut self) {
        while !self.unit_reading {
            let Some(job) = self.unit_jobs.pop_front() else { return };
            let (deps, id, jobs) = (self.deps.clone(), self.id.clone(), self.jobs_tx.clone());
            match job {
                UnitJob::Ready(tx) => {
                    let _ = tx.send(());
                }
                UnitJob::Record(iid) => {
                    self.unit_reading = true;
                    tokio::spawn(async move {
                        let read = read_record(&deps, &id, &iid).await.unwrap_or_else(|error| {
                            unread(&id, "a stored record", &error);
                            None
                        });
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
                        let (rev, units) = read_held(&deps, &id, spans).await.unwrap_or_else(|error| {
                            unread(&id, "a held range", &error);
                            (0, Vec::new())
                        });
                        let _ = jobs.send(JobDone::UnitsRead(Box::new(UnitsRead::Held(rev, units))));
                    });
                }
                UnitJob::Tail => {
                    self.unit_reading = true;
                    tokio::spawn(async move {
                        let ctl = ctl("thread/transcript/unit", &id, "tail", CancellationToken::new());
                        let read = reads::units(&deps.store, &deps.transcript, deps.lanes, &id, PageAt::Newest, window::TAIL_RECORDS, &ctl)
                            .await
                            .unwrap_or_else(|error| {
                                unread(&id, "the newest records", &error);
                                None
                            });
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
                    let budget = self.feed.frame_budget();
                    tokio::spawn(async move {
                        let ctl = ctl("thread/window/set", &id, &ask.params.request_id, ask.cancel.clone());
                        let read = window::demand(&deps, &id, &held, &ask.params.request_id, &ask.params.want, budget, &ctl).await;
                        let _ = jobs.send(JobDone::UnitsRead(Box::new(UnitsRead::Demand(ask, Box::new(held), read))));
                    });
                }
            }
        }
    }

    pub(super) fn units_read(&mut self, read: UnitsRead) {
        self.unit_reading = false;
        match read {
            UnitsRead::Record(Some(reading)) => self.deliver_unit(reading.rev, reading.unit, reading.after, reading.older),
            UnitsRead::Record(None) => {}
            UnitsRead::Held(rev, units) => {
                for unit in units {
                    self.deliver_unit(rev, unit, None, true);
                }
            }
            UnitsRead::Tail(read) => self.tail_read(read),
            UnitsRead::Demand(ask, held, read) => {
                let WindowAsk { params, tx, .. } = *ask;
                let _ = tx.send(read.and_then(|demand| self.install_demand(&params, &held, demand)));
            }
        }
        self.next_unit_job();
    }

    /// The stored record as it reads now: to the snapshot's tail when it belongs there, and to every positioned
    /// subscription whose grant holds it, in one step with the view that carries it.
    fn deliver_unit(&mut self, rev: u64, unit: StoredUnit, after: Option<String>, older: bool) {
        let lineage = self.acked.history_rev;
        // A read of a history revision that is gone tells nothing of this one.
        if rev != lineage {
            return;
        }
        let unit = Arc::new(unit);
        match self.tail.iter().position(|held| held.ordinal >= unit.ordinal) {
            Some(at) if self.tail[at].ordinal == unit.ordinal => self.tail[at] = unit.clone(),
            // Older than everything the tail holds: a page of it shows it.
            Some(0) => {}
            Some(at) => self.tail.insert(at, unit.clone()),
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
    /// sent them in its snapshot.
    pub(super) fn tail_ready(&mut self, tx: oneshot::Sender<()>) {
        self.unit_job(UnitJob::Ready(tx));
    }
}

/// The calls whose records are remembered until their results are stored.
const CALL_RECORDS: usize = 4096;
