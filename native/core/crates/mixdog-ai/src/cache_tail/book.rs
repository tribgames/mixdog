//! One session's transcript-cache book: the proven tail entries per route, the cold disposition of the history it last
//! decided, and the decision in flight. Pure state; [`super::SessionGate`] serializes access and supplies the clock.

use std::collections::BTreeSet;
use std::sync::Arc;

use mixdog_core_api::domain::cache_tail::{
    Admission, Claim, Cold, ColdRequest, Counters, Digest, Permit, Purpose, Resolution, TailRefusal, TailRoute, Unreduced, Verdict, WireManifest,
};
use serde_json::{Value, json};

use super::evidence::{Evidence, Extent, interpret};

/// The snapshot format; a snapshot of another version is ignored (the history is then judged unproven once). Version 3
/// (earlier 1.5.0 builds) kept a failed rewrite as a disposition and a compacted base as an unbound flag.
const VERSION: u64 = 4;

/// A proven tail entry on one route. It is kept exactly as long as the provider's entry it proves can be alive.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Receipt {
    pub route: TailRoute,
    pub block: usize,
    pub digest: Digest,
    pub ttl_ms: u64,
    /// The dispatch instant of the attempt that proved it (never its completion).
    pub touched_at: i64,
    pub extent: Option<u64>,
}

#[cfg(test)]
mod first_permit_tests {
    use super::*;

    #[test]
    fn a_sparse_overlapping_answer_keeps_the_same_tail_state_in_either_completion_order() {
        let route = TailRoute("anthropic|account".into());
        let manifest = super::super::manifest::anthropic(&json!({
            "messages": [{"role": "user", "content": [{"type": "text", "text": "prompt", "cache_control": {"type": "ephemeral"}}]}]
        }));
        let settled = |older_report, older_first| {
            let mut book = Book::default();
            let mut admit = |now| match book.admit(
                Admission { purpose: Purpose::Turn, route: &route, manifest: &manifest, generation: None, unreduced: None },
                now,
                true,
                1,
            ) {
                Verdict::Send(permit) => permit,
                Verdict::Refuse(refusal) => panic!("unexpected refusal: {refusal:?}"),
            };
            let older = admit(1);
            let newer = admit(2);
            let sparse = Some(Counters { read: Some(0), ..Counters::default() });
            if older_first {
                book.settle(&older, older_report, 3);
                book.settle(&newer, sparse, 3);
            } else {
                book.settle(&newer, sparse, 3);
                book.settle(&older, older_report, 3);
            }
            assert_eq!(book.judge(&route, &manifest, 3 + mixdog_core_api::domain::cache_tail::TTL_5M_MS as i64), Judgment::Cold(Cold::Expired));
            assert!(book.receipts().is_empty(), "a missing creation counter is not evidence");
            book.to_json()
        };
        for older_report in [None, Some(Counters { read: Some(0), created: Some(0), ..Counters::default() })] {
            assert_eq!(settled(older_report, true), settled(older_report, false));
        }
    }

    #[test]
    fn overlapping_cache_proof_survives_first_write_cancellation_in_either_order() {
        let route = TailRoute("anthropic|account".into());
        let manifest = super::super::manifest::anthropic(&json!({
            "messages": [{"role": "user", "content": [{"type": "text", "text": "prompt", "cache_control": {"type": "ephemeral"}}]}]
        }));
        for cancel_first in [true, false] {
            let mut book = Book::default();
            let mut admit = |now| match book.admit(
                Admission { purpose: Purpose::Turn, route: &route, manifest: &manifest, generation: None, unreduced: None },
                now,
                true,
                1,
            ) {
                Verdict::Send(permit) => permit,
                Verdict::Refuse(refusal) => panic!("unexpected refusal: {refusal:?}"),
            };
            let first = admit(1);
            let overlapping = admit(1);
            let report = Some(Counters { read: Some(0), created: Some(9), created_5m: Some(9), created_1h: Some(0) });
            if cancel_first {
                book.settle(&first, None, 2);
                book.settle(&overlapping, report, 2);
            } else {
                book.settle(&overlapping, report, 2);
                book.settle(&first, None, 2);
            }
            assert_eq!(
                book.judge(&route, &manifest, 2 + mixdog_core_api::domain::cache_tail::TTL_5M_MS as i64),
                Judgment::Cold(Cold::Expired),
                "an expired proof must not be mistaken for a first write"
            );
        }
    }
}

impl Receipt {
    fn alive(&self, now: i64) -> bool {
        now >= self.touched_at && ((now - self.touched_at) as u64) <= self.ttl_ms
    }
}

/// What a cold decision of a history settled.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decided {
    /// The history is the base a compaction committed.
    Compacted,
    /// No smaller valid transcript exists.
    Irreducible,
    /// No context window sizes a compaction.
    NoSizing,
}

/// The cold decision of the history a send covered, and the sizing policy it was decided under. A changed policy retires
/// it everywhere; a later proof on a route (whose expiry there is a fresh one) retires it for that route alone.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Disposition {
    pub block: usize,
    pub digest: Digest,
    pub resolution: Decided,
    pub sizing: u64,
    /// The routes (their [`TailRoute`] text) a proof settled on since the decision: there the history's later expiry is a
    /// fresh one, and the decision no longer holds.
    pub retired: BTreeSet<String>,
}

/// A rewrite of one history (its tail under one sizing policy): offered to the cold callers of that history, or claimed by
/// one (its owner) while every other cold caller waits for its outcome.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Pending {
    ticket: u64,
    block: usize,
    digest: Digest,
    sizing: u64,
}

impl Pending {
    fn of(&self, block: usize, digest: Digest) -> bool {
        self.block == block && self.digest == digest
    }
}

/// What the book makes of an attempt's transcript right now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Judgment {
    /// No session message cache target.
    NotApplicable,
    /// Genuinely new history: no attempt of this session was dispatched before.
    FirstWrite,
    /// A proven entry on this route is reachable and inside its lifetime, for `holds_ms` more (the longest such entry's).
    Live {
        holds_ms: u64,
    },
    Cold(Cold),
}

#[derive(Default, Debug)]
pub struct Book {
    generation: u64,
    receipts: Vec<Receipt>,
    disposition: Option<Disposition>,
    /// A compaction committed this generation's history and no caller that writes a base ([`Purpose::Turn`],
    /// [`Purpose::SideAfterCompaction`]) has admitted a marked write of it yet: the first one is the compacted base, and the
    /// disposition is bound to its tail then, whatever that admission is judged.
    rebuilt: bool,
    /// Confirmed send state, separate from a speculative first dispatch.
    sent: bool,
    /// The pending first dispatch makes the history appear sent until its report or a later one settles.
    first: Option<u64>,
    /// The newest dispatched permit that settled `sent` for this generation.
    sent_permit: Option<u64>,
    /// The dispatch instant of the session's newest answered send of its transcript, on whatever route (Node's
    /// `lastProviderSendAt`): the tail's lifetime runs from it.
    last_send: Option<i64>,
    /// The claimed rewrite. Only a claim installs it ([`Book::claim`]): an offer that is never claimed holds nothing.
    pending: Option<Pending>,
    /// The unclaimed rewrite of the session's current history: a turn admitting any other history (an append included),
    /// a claim or a rewrite ends it.
    offer: Option<Pending>,
    /// The last permit or ticket id this book gave: an id names a permit or a rewrite of this book only.
    ids: u64,
    dirty: bool,
}

fn hex(digest: &Digest) -> String {
    digest.0.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Digest> {
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(Digest(out))
}

fn decided_name(decided: Decided) -> &'static str {
    match decided {
        Decided::Compacted => "compacted",
        Decided::Irreducible => "irreducible",
        Decided::NoSizing => "no_sizing",
    }
}

fn decided_of(name: &str) -> Option<Decided> {
    Some(match name {
        "compacted" => Decided::Compacted,
        "irreducible" => Decided::Irreducible,
        "no_sizing" => Decided::NoSizing,
        _ => return None,
    })
}

impl Book {
    /// The book of a session with no record: `fresh` only for a session whose history holds nothing sent before (a new
    /// session's first prompt); any other unrecorded history (an upgrade, an import) is not new. `last_send`: when the
    /// session last sent, as its header records it (a session of an earlier version has only that).
    pub fn unrecorded(fresh: bool, last_send: Option<i64>) -> Self {
        Self { sent: !fresh, last_send, ..Self::default() }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn pending_ticket(&self) -> Option<u64> {
        self.pending.map(|p| p.ticket)
    }

    pub fn receipts(&self) -> &[Receipt] {
        &self.receipts
    }

    pub fn disposition(&self) -> Option<&Disposition> {
        self.disposition.as_ref()
    }

    fn prune(&mut self, now: i64) {
        let before = self.receipts.len();
        self.receipts.retain(|r| r.alive(now));
        self.dirty |= self.receipts.len() != before;
    }

    fn next_id(&mut self) -> u64 {
        self.ids += 1;
        self.ids
    }

    /// The tail is judged by time alone, as Node judged it (`sessionTailCacheExpired`, `shouldCompactForExpiredAgentCache`):
    /// it is alive for its lifetime after the session's last answered send, or after a later use of it on this route (a
    /// warm). Which blocks that send wrote decides nothing here: a request that grew past the provider's lookback, or an
    /// edited one, is still sent inside the lifetime, and what it costs is the provider's to report.
    pub fn judge(&self, route: &TailRoute, manifest: &WireManifest, now: i64) -> Judgment {
        let Some(tail) = manifest.tail_marker() else { return Judgment::NotApplicable };
        let used = self.receipts.iter().filter(|r| &r.route == route).map(|r| r.touched_at).chain(self.last_send).filter(|at| now >= *at).max();
        let age = used.map(|at| (now - at) as u64);
        // Expired only past the lifetime: at the lifetime itself the tail still holds (Node: `now - lastSendAt <= ttl`).
        if let Some(age) = age.filter(|age| *age <= tail.ttl_ms) {
            return Judgment::Live { holds_ms: tail.ttl_ms - age };
        }
        if !self.sent && self.first.is_none() {
            return Judgment::FirstWrite;
        }
        match age {
            Some(_) => Judgment::Cold(Cold::Expired),
            // No send on record (an upgrade, an import, a clock that went back): nothing is known to have run out.
            None => Judgment::Cold(Cold::Unproven),
        }
    }

    /// `holds_ms`: how long the judgement that admits it holds ([`Permit::holds_ms`]).
    fn permit(&mut self, admission: &Admission<'_>, now: i64, holds_ms: Option<u64>) -> Verdict {
        let id = self.next_id();
        if matches!(admission.purpose, Purpose::Turn | Purpose::SideQuestion | Purpose::SideAfterCompaction)
            && admission.manifest.tail.is_some()
            && !self.sent
            && self.first.is_none()
        {
            self.first = Some(id);
            self.dirty = true;
        }
        Verdict::Send(Permit {
            id,
            route: admission.route.clone(),
            purpose: admission.purpose,
            manifest: Arc::new(admission.manifest.clone()),
            dispatched_at: now,
            generation: self.generation,
            holds_ms,
        })
    }

    /// The decision for one attempt, at `now`. `auto_clear`: the user's auto-clear setting is on (off, the cold action is
    /// skipped and evidence is still collected). `sizing`: the session's compaction sizing policy as it stands.
    pub fn admit(&mut self, admission: Admission<'_>, now: i64, auto_clear: bool, sizing: u64) -> Verdict {
        if admission.generation.is_some_and(|generation| generation != self.generation) {
            return Verdict::Refuse(TailRefusal::Stale);
        }
        let judgment = self.judge(admission.route, admission.manifest, now);
        let tail = admission.manifest.tail_marker();
        let owner_side = matches!(admission.purpose, Purpose::Turn | Purpose::SideQuestion | Purpose::SideAfterCompaction);
        // Who may write a compacted base unchanged: the turn, and a side question rebuilt from the history its own idle
        // compaction committed. A plain side question may carry a body from before a running turn's rewrite.
        let base_writer = matches!(admission.purpose, Purpose::Turn | Purpose::SideAfterCompaction);
        if base_writer
            && let Some(tail) = tail
            && std::mem::take(&mut self.rebuilt)
        {
            // The compacted base itself: written now, on whatever route serves it, and never summarized again.
            self.disposition = Some(Disposition { block: tail.block, digest: tail.digest, resolution: Decided::Compacted, sizing, retired: BTreeSet::new() });
            self.dirty = true;
        }
        // The turn's transcript is the session's history: once it is another one (an append included), the rewrite offered
        // for the old one has nothing left to rewrite.
        if admission.purpose == Purpose::Turn
            && let Some(tail) = tail
            && self.offer.is_some_and(|offer| !offer.of(tail.block, tail.digest))
        {
            self.offer = None;
        }
        let cold = match judgment {
            Judgment::Live { holds_ms } => return self.permit(&admission, now, Some(holds_ms)),
            Judgment::NotApplicable | Judgment::FirstWrite => return self.permit(&admission, now, None),
            Judgment::Cold(cold) => cold,
        };
        if !owner_side {
            return Verdict::Refuse(TailRefusal::Skip(cold));
        }
        if !auto_clear {
            return self.permit(&admission, now, None);
        }
        // Only a lifetime that ran out is an expiry. A history with no send on record may be held by the provider all the
        // same: it is sent as it is, and that send is its record. The compacted base no caller has written yet is not
        // such a history: only a base writer sends it.
        if cold == Cold::Unproven && !self.rebuilt {
            return self.permit(&admission, now, None);
        }
        let tail = tail.expect("a cold judgment has a tail");
        if admission.unreduced.is_some_and(|leave| leave.block == tail.block && leave.digest == tail.digest) {
            return self.permit(&admission, now, None);
        }
        let route = &admission.route.0;
        if self.disposition.as_ref().is_some_and(|d| d.block == tail.block && d.digest == tail.digest && d.sizing == sizing && !d.retired.contains(route)) {
            return self.permit(&admission, now, None);
        }
        if let Some(pending) = self.pending {
            return Verdict::Refuse(TailRefusal::Wait(pending.ticket));
        }
        if admission.purpose != Purpose::Turn {
            // A side question never owns the run's rewrite: its caller compacts the idle session itself.
            return Verdict::Refuse(TailRefusal::Skip(cold));
        }
        // Offered, not held: the caller that claims it owns the rewrite, so a caller dropped before it claims holds nothing.
        // Every cold caller of this history is offered the same rewrite; one under another sizing policy replaces it.
        let ticket = match self.offer.filter(|offer| offer.of(tail.block, tail.digest) && offer.sizing == sizing) {
            Some(offer) => offer.ticket,
            None => {
                let ticket = self.next_id();
                self.offer = Some(Pending { ticket, block: tail.block, digest: tail.digest, sizing });
                ticket
            }
        };
        Verdict::Refuse(TailRefusal::Rebuild(ColdRequest { ticket, cold }))
    }

    /// A caller takes the rewrite it was offered: it owns it unless another caller claimed one first (it then waits for
    /// that outcome), or the offer ended (the history changed, or another caller's claim was decided).
    pub fn claim(&mut self, ticket: u64) -> Claim {
        if let Some(pending) = self.pending {
            return Claim::Wait(pending.ticket);
        }
        match self.offer.take_if(|offer| offer.ticket == ticket) {
            Some(offer) => {
                self.pending = Some(offer);
                Claim::Owner
            }
            None => Claim::Stale,
        }
    }

    /// A proof settled on `route`: a decision taken before it no longer holds there.
    fn proven_on(&mut self, permit: &Permit) {
        self.settle_sent(permit, true);
        if let Some(disposition) = &mut self.disposition {
            disposition.retired.insert(permit.route.0.clone());
        }
        self.dirty = true;
    }

    fn settle_sent(&mut self, permit: &Permit, sent: bool) {
        if permit.generation != self.generation || self.sent_permit.is_some_and(|id| id >= permit.id) {
            return;
        }
        self.sent_permit = Some(permit.id);
        let dropped_first = self.first.take_if(|first| *first <= permit.id).is_some();
        self.dirty |= dropped_first || self.sent != sent;
        self.sent = sent;
    }

    /// What the permitted attempt reported, at `now`.
    pub fn settle(&mut self, permit: &Permit, counters: Option<Counters>, now: i64) {
        // A canceled first dispatch withdraws only its speculative state, never an overlapping report.
        if permit.generation == self.generation && self.first.take_if(|first| *first == permit.id).is_some() {
            self.dirty = true;
        }
        // Every answered send of the session moves its last send, a request without a tail marker too (Node's
        // `lastProviderSendAt`). A warm reads the tail without being a send of the session: it moves its route's entry
        // below, never this.
        if counters.is_some() && permit.purpose != Purpose::Warm && self.last_send.is_none_or(|at| at < permit.dispatched_at) {
            self.last_send = Some(permit.dispatched_at);
            self.dirty = true;
        }
        // Any other write that reported nothing (refused, failed in transport) changes nothing, not even which expired
        // entries are kept: a replay after it still knows its history's entry expired rather than never existed.
        let Some(counters) = counters else { return };
        let Some(tail) = permit.manifest.tail_marker() else {
            if permit.purpose != Purpose::Warm {
                self.settle_sent(permit, true);
            }
            return;
        };
        self.prune(now);
        if permit.generation != self.generation {
            return;
        }
        let known: Vec<Extent> = self
            .receipts
            .iter()
            .filter(|r| r.route == permit.route)
            .filter_map(|r| Some(Extent { block: r.block, digest: r.digest, tokens: r.extent? }))
            .collect();
        let evidence = interpret(&permit.manifest, counters, &known);
        if permit.purpose != Purpose::Warm || evidence == Evidence::Untouched {
            // A sparse answer confirms the transcript was sent, not that any cache entry was read or written.
            self.settle_sent(permit, evidence != Evidence::Untouched);
        }
        match evidence {
            Evidence::Wrote { extent } => {
                let existing = self.receipts.iter_mut().find(|r| r.route == permit.route && r.block == tail.block && r.digest == tail.digest);
                match existing {
                    Some(receipt) if receipt.touched_at > permit.dispatched_at => return,
                    Some(receipt) => {
                        receipt.ttl_ms = tail.ttl_ms;
                        receipt.touched_at = permit.dispatched_at;
                        receipt.extent = Some(extent);
                    }
                    None => self.receipts.push(Receipt {
                        route: permit.route.clone(),
                        block: tail.block,
                        digest: tail.digest,
                        ttl_ms: tail.ttl_ms,
                        touched_at: permit.dispatched_at,
                        extent: Some(extent),
                    }),
                }
                self.proven_on(permit);
            }
            Evidence::Refreshed { block, digest } => {
                if let Some(receipt) =
                    self.receipts.iter_mut().find(|r| r.route == permit.route && r.block == block && r.digest == digest && r.touched_at < permit.dispatched_at)
                {
                    receipt.touched_at = permit.dispatched_at;
                    self.proven_on(permit);
                }
            }
            Evidence::Untouched | Evidence::Unknown => {}
        }
    }

    /// What the owner of the claimed rewrite `ticket` did. A failed reduction proves nothing about the history: the book keeps
    /// nothing of it and hands the owner the leave of the one request it was decided for.
    pub fn resolve(&mut self, ticket: u64, resolution: Resolution) -> Option<Unreduced> {
        let pending = self.pending.take_if(|p| p.ticket == ticket)?;
        let decided = match resolution {
            // `rebuilt` was already marked by the run that adopted the compacted transcript.
            Resolution::Compacted | Resolution::Abandoned => return None,
            Resolution::Failed => return Some(Unreduced { block: pending.block, digest: pending.digest }),
            Resolution::Irreducible => Decided::Irreducible,
            Resolution::NoSizing => Decided::NoSizing,
        };
        self.disposition =
            Some(Disposition { block: pending.block, digest: pending.digest, resolution: decided, sizing: pending.sizing, retired: BTreeSet::new() });
        self.dirty = true;
        None
    }

    /// The book leaves memory: no rewrite stays claimed or offered on it.
    pub fn retire(&mut self) {
        self.pending = None;
        self.offer = None;
    }

    pub fn rebuilt(&mut self) {
        self.sent |= self.first.take().is_some();
        self.sent_permit = None;
        self.generation += 1;
        self.rebuilt = true;
        self.pending = None;
        self.offer = None;
        self.dirty = true;
    }

    /// The book as persisted, once after each change.
    pub fn take_snapshot(&mut self) -> Option<Value> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        Some(self.to_json())
    }

    pub fn to_json(&self) -> Value {
        json!({
            "v": VERSION,
            "generation": self.generation,
            "rebuilt": self.rebuilt,
            "sent": self.sent || self.first.is_some(),
            "lastSendAt": self.last_send,
            "receipts": self.receipts.iter().map(|r| json!({
                "route": r.route.0,
                "block": r.block,
                "digest": hex(&r.digest),
                "ttlMs": r.ttl_ms,
                "touchedAt": r.touched_at,
                "extent": r.extent,
            })).collect::<Vec<_>>(),
            "disposition": self.disposition.as_ref().map(|d| json!({ "block": d.block, "digest": hex(&d.digest), "resolution": decided_name(d.resolution), "sizing": d.sizing, "retired": d.retired })),
        })
    }

    /// The book a snapshot persisted, as a process starting at `now` may trust it: a time that lies ahead of the clock is
    /// uncertain and dropped, an expired entry is gone (the last send's time still tells the expiry); no decision in
    /// flight survives. A snapshot of another version is a history this book did not record: `last_send` (the header's
    /// own record of the last send) is then all that is known of it.
    pub fn from_json(value: &Value, now: i64, last_send: Option<i64>) -> Self {
        if value.get("v").and_then(Value::as_u64) != Some(VERSION) {
            return Self::unrecorded(false, last_send);
        }
        let receipts = value
            .get("receipts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|r| {
                Some(Receipt {
                    route: TailRoute(r.get("route")?.as_str()?.to_owned()),
                    block: r.get("block")?.as_u64()? as usize,
                    digest: unhex(r.get("digest")?.as_str()?)?,
                    ttl_ms: r.get("ttlMs")?.as_u64()?,
                    touched_at: r.get("touchedAt")?.as_i64()?,
                    extent: r.get("extent").and_then(Value::as_u64),
                })
            })
            .filter(|r: &Receipt| r.alive(now))
            .collect();
        let disposition = value.get("disposition").and_then(|d| {
            Some(Disposition {
                block: d.get("block")?.as_u64()? as usize,
                digest: unhex(d.get("digest")?.as_str()?)?,
                resolution: decided_of(d.get("resolution")?.as_str()?)?,
                sizing: d.get("sizing")?.as_u64()?,
                retired: d.get("retired")?.as_array()?.iter().map(|route| route.as_str().map(str::to_owned)).collect::<Option<_>>()?,
            })
        });
        Self {
            generation: value.get("generation").and_then(Value::as_u64).unwrap_or(0),
            receipts,
            disposition,
            rebuilt: value.get("rebuilt").and_then(Value::as_bool).unwrap_or(false),
            sent: value.get("sent").and_then(Value::as_bool).unwrap_or(true),
            // The later of the two records: the header's is written by every send, the book's only by a send it settled.
            last_send: value.get("lastSendAt").and_then(Value::as_i64).into_iter().chain(last_send).filter(|at| now >= *at).max(),
            first: None,
            sent_permit: None,
            pending: None,
            offer: None,
            ids: 0,
            dirty: false,
        }
    }
}
