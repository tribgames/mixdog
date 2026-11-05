//! The receiver stream core (`RemoteTransportReceiver`): reorder, dedup, bounded buffer, chunk
//! reassembly BEFORE decryption, loss detection and ack scheduling. Pure: time is passed in.

use std::collections::{BTreeMap, BTreeSet};

use super::consts::{
    ACK_ELICITING_THRESHOLD, CANDIDATES_PER_SLOT, CHUNK_BYTES, FUTURE_BUDGET_BYTES, MAX_ACK_DELAY_MS, MAX_ACK_RANGES,
    MAX_IDLE_TIMEOUT_MS, MAX_RECORD_BYTES, MAX_RECORDS_IN_FLIGHT, PACKET_THRESHOLD, PTO_PROBES, record_charge,
};
use super::frame::RecordMessage;
use super::path::{PathMonitor, RttEstimate};
use super::TransportError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcceptResult {
    Buffered,
    Duplicate,
    OutOfWindow,
    OverMemory,
    /// The chunk's embedded box sequence is not the sequence it claims.
    Mismatch,
}

/// One possible reading of a slot. Geometry is unauthenticated until the assembled box opens, so
/// rival geometries are separate candidates.
struct Candidate {
    total: usize,
    buffer: Vec<u8>,
    /// Per-chunk presence; `None` for a whole record.
    filled: Option<Vec<bool>>,
    count: u32,
    received: u32,
    progress_at: u64,
}

impl Candidate {
    fn complete(&self) -> bool {
        self.received == self.count
    }
}

#[derive(Default)]
struct Slot {
    candidates: Vec<Candidate>,
    bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiverStats {
    pub delivered_through: u64,
    pub buffered_records: usize,
    pub buffered_bytes: usize,
    pub head_bytes: usize,
    pub future_bytes: usize,
    pub duplicates: u64,
    pub discarded: u64,
    pub evicted: u64,
}

/// An ack to seal and send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AckDue {
    pub through: u64,
    pub ranges: Vec<(u64, u64)>,
}

/// Whether `head` (a box prefix) is an app box sealed under `sequence`.
fn header_names(head: &[u8], sequence: u64) -> bool {
    head.len() >= 12 && head[..4] == [0x4d, 0x58, 0x45, 0x01] && u64::from_be_bytes(head[4..12].try_into().expect("8 bytes")) == sequence
}

#[derive(Default)]
pub struct Receiver {
    slots: BTreeMap<u64, Slot>,
    delivered: u64,
    bytes: usize,
    acked_through: u64,
    unacked_records: u64,
    unacked_since: Option<u64>,
    force_ack: bool,
    duplicates: u64,
    discarded: u64,
    evicted: u64,
    /// Copies discarded or evicted here: explicit losses, declared next round.
    repairs: BTreeSet<u64>,
    /// Missing, not yet declared lost: when the evidence arrived.
    gaps: BTreeMap<u64, u64>,
    /// Declared lost (repair already requested once); recovered by PTO.
    lost: BTreeSet<u64>,
    evidence_through: u64,
    highest_arrived: u64,
    pto_armed_at: Option<u64>,
    pto_count: u32,
}

impl Receiver {
    pub fn new() -> Self {
        Self::default()
    }

    fn head_bytes(&self) -> usize {
        self.slots.get(&(self.delivered + 1)).map_or(0, |slot| slot.bytes)
    }

    /// Room for `size` more bytes in `sequence`'s slot after freeing `freed`.
    fn fits(&self, sequence: u64, slot_bytes: usize, size: usize, freed: usize) -> bool {
        let slot_bytes = slot_bytes + size - freed.min(slot_bytes + size);
        if slot_bytes > CANDIDATES_PER_SLOT * MAX_RECORD_BYTES {
            return false;
        }
        if sequence == self.delivered + 1 {
            return true;
        }
        (self.bytes - self.head_bytes()) + size <= FUTURE_BUDGET_BYTES + freed
    }

    fn remove_candidate(&mut self, sequence: u64, index: usize) {
        let slot = self.slots.get_mut(&sequence).expect("slot");
        let candidate = slot.candidates.remove(index);
        let charge = record_charge(candidate.total);
        slot.bytes -= charge;
        self.bytes -= charge;
        if slot.candidates.is_empty() {
            self.slots.remove(&sequence);
        }
    }

    fn has_complete(&self, sequence: u64) -> bool {
        self.slots.get(&sequence).is_some_and(|slot| slot.candidates.iter().any(Candidate::complete))
    }

    /// Marks every sequence above what was already examined, up to `through`, as missing since
    /// `now` unless a complete copy is here.
    fn note_evidence(&mut self, through: u64, now: u64) {
        let last = through.min(self.delivered + MAX_RECORDS_IN_FLIGHT);
        let mut sequence = self.delivered.max(self.evidence_through) + 1;
        while sequence <= last {
            if !self.has_complete(sequence) && !self.lost.contains(&sequence) && !self.gaps.contains_key(&sequence) {
                self.gaps.insert(sequence, now);
            }
            sequence += 1;
        }
        self.evidence_through = self.evidence_through.max(last);
    }

    /// Evicts every incomplete assembly that made no progress for `idle_ms`.
    pub fn sweep(&mut self, now: u64, idle_ms: f64) -> usize {
        let mut count = 0;
        let sequences: Vec<u64> = self.slots.keys().copied().collect();
        for sequence in sequences {
            let mut index = 0;
            while let Some(candidate) = self.slots.get(&sequence).and_then(|slot| slot.candidates.get(index)) {
                if candidate.complete() || (now.saturating_sub(candidate.progress_at) as f64) < idle_ms {
                    index += 1;
                    continue;
                }
                self.remove_candidate(sequence, index);
                self.repairs.insert(sequence);
                count += 1;
            }
        }
        self.evicted += count as u64;
        count
    }

    /// The default idle bound for [`Self::sweep`].
    pub fn sweep_default(&mut self, now: u64) -> usize {
        self.sweep(now, MAX_IDLE_TIMEOUT_MS)
    }

    pub fn accept(&mut self, message: &RecordMessage, now: u64) -> AcceptResult {
        let sequence = message.sequence();
        if sequence <= self.delivered {
            // The sender may have lost our ack: say it again.
            self.duplicates += 1;
            self.force_ack = true;
            self.unacked_since.get_or_insert(now);
            return AcceptResult::Duplicate;
        }
        if sequence > self.delivered + MAX_RECORDS_IN_FLIGHT {
            return AcceptResult::OutOfWindow;
        }
        // Chunk 0 carries the box header: its embedded sequence must be the one the chunk claims.
        if let RecordMessage::Chunk { index: 0, data, .. } = message {
            if !header_names(data, sequence) {
                return AcceptResult::Mismatch;
            }
        }
        // A later record is evidence about every earlier one (RFC 9002 §6.1).
        if sequence > self.highest_arrived {
            self.highest_arrived = sequence;
            self.note_evidence(sequence - 1, now);
        }
        if let RecordMessage::Chunk { index, total, data, .. } = message {
            let same = self.slots.get(&sequence).and_then(|slot| {
                slot.candidates.iter().position(|candidate| candidate.filled.is_some() && candidate.total == *total as usize)
            });
            if let Some(position) = same {
                let slot = self.slots.get_mut(&sequence).expect("slot");
                let candidate = &mut slot.candidates[position];
                let filled = candidate.filled.as_mut().expect("chunked");
                if candidate.received == candidate.count || filled[*index as usize] {
                    self.duplicates += 1;
                    return AcceptResult::Duplicate;
                }
                let at = *index as usize * CHUNK_BYTES;
                candidate.buffer[at..at + data.len()].copy_from_slice(data);
                filled[*index as usize] = true;
                candidate.received += 1;
                candidate.progress_at = now;
                // A complete assembly is exposed only when its box names this slot.
                if candidate.complete() && !header_names(&candidate.buffer, sequence) {
                    self.remove_candidate(sequence, position);
                    self.discarded += 1;
                    return AcceptResult::Mismatch;
                }
                return AcceptResult::Buffered;
            }
        } else if self.slots.get(&sequence).is_some_and(|slot| slot.candidates.iter().any(|c| c.filled.is_none())) {
            self.duplicates += 1;
            return AcceptResult::Duplicate;
        }
        let total = match message {
            RecordMessage::App { box_bytes, .. } => box_bytes.len(),
            RecordMessage::Chunk { total, .. } => *total as usize,
        };
        // A full slot makes room by evicting its least advanced incomplete rival.
        let mut victim: Option<usize> = None;
        if let Some(slot) = self.slots.get(&sequence) {
            if slot.candidates.len() >= CANDIDATES_PER_SLOT {
                for (position, candidate) in slot.candidates.iter().enumerate() {
                    if candidate.complete() {
                        continue;
                    }
                    let better = victim.is_none_or(|v| {
                        let current = &slot.candidates[v];
                        candidate.received < current.received
                            || (candidate.received == current.received && candidate.progress_at < current.progress_at)
                    });
                    if better {
                        victim = Some(position);
                    }
                }
                if victim.is_none() {
                    self.duplicates += 1;
                    return AcceptResult::Duplicate;
                }
            }
        }
        // Every candidate is charged at least one carrier message.
        let charge = record_charge(total);
        let freed = |this: &Self, victim: Option<usize>| {
            victim.map_or(0, |position| record_charge(this.slots[&sequence].candidates[position].total))
        };
        let slot_bytes = |this: &Self| this.slots.get(&sequence).map_or(0, |slot| slot.bytes);
        if !self.fits(sequence, slot_bytes(self), charge, freed(self, victim)) {
            // `sweep` may remove the victim (and others): identify it by value afterwards.
            let victim_key = victim.map(|position| {
                let candidate = &self.slots[&sequence].candidates[position];
                (candidate.total, candidate.received, candidate.progress_at)
            });
            self.sweep_default(now);
            victim = victim_key.and_then(|key| {
                self.slots.get(&sequence).and_then(|slot| {
                    slot.candidates
                        .iter()
                        .position(|c| (c.total, c.received, c.progress_at) == key && !c.complete())
                })
            });
            if !self.fits(sequence, slot_bytes(self), charge, freed(self, victim)) {
                return AcceptResult::OverMemory;
            }
        }
        if let Some(position) = victim {
            self.remove_candidate(sequence, position);
            self.repairs.insert(sequence);
            self.evicted += 1;
        }
        // Reserved: allocate.
        let candidate = match message {
            RecordMessage::App { box_bytes, .. } => Candidate {
                total,
                buffer: box_bytes.clone(),
                filled: None,
                count: 1,
                received: 1,
                progress_at: now,
            },
            RecordMessage::Chunk { index, count, data, .. } => {
                let mut buffer = vec![0u8; total];
                let at = *index as usize * CHUNK_BYTES;
                buffer[at..at + data.len()].copy_from_slice(data);
                let mut filled = vec![false; *count as usize];
                filled[*index as usize] = true;
                Candidate { total, buffer, filled: Some(filled), count: *count, received: 1, progress_at: now }
            }
        };
        let slot = self.slots.entry(sequence).or_default();
        slot.candidates.push(candidate);
        slot.bytes += charge;
        self.bytes += charge;
        AcceptResult::Buffered
    }

    fn head_candidate(&self) -> Option<&Candidate> {
        self.slots.get(&(self.delivered + 1))?.candidates.iter().find(|candidate| candidate.complete())
    }

    /// The next box in order, complete, naming its own sequence, not yet opened; `None` when none
    /// has arrived. Repeated calls return the same box until `commit`/`discard`.
    pub fn next(&self) -> Option<(u64, &[u8])> {
        self.head_candidate().map(|candidate| (self.delivered + 1, candidate.buffer.as_slice()))
    }

    /// The head box opened under the session key: it is accepted.
    pub fn commit(&mut self, sequence: u64, now: u64) -> Result<(), TransportError> {
        if sequence != self.delivered + 1 {
            return Err(TransportError::invalid("commit order"));
        }
        if self.head_candidate().is_none() {
            return Err(TransportError::invalid("commit slot"));
        }
        let slot = self.slots.remove(&sequence).expect("head slot");
        self.bytes -= slot.bytes;
        self.delivered = sequence;
        self.unacked_records += 1;
        self.unacked_since.get_or_insert(now);
        self.gaps.remove(&sequence);
        self.lost.remove(&sequence);
        // Progress resets pto_count; a sequence already declared lost stays declared.
        self.pto_count = 0;
        if !self.lost.is_empty() {
            self.pto_armed_at = Some(now);
        }
        Ok(())
    }

    /// The head box failed authentication: that candidate goes; a rival, or the copy `repair_due`
    /// asks the sender for, fills the slot.
    pub fn discard(&mut self, sequence: u64) {
        if sequence != self.delivered + 1 {
            return;
        }
        let Some(position) = self
            .slots
            .get(&sequence)
            .and_then(|slot| slot.candidates.iter().position(Candidate::complete))
        else {
            return;
        };
        self.remove_candidate(sequence, position);
        self.discarded += 1;
        self.repairs.insert(sequence);
    }

    /// An authenticated `ping.sent`: everything up to it has left the sender's queue, so it is
    /// evidence about every sequence at or below it — the only way to find a lost FINAL record.
    pub fn probe(&mut self, sent: u64, now: u64) {
        self.note_evidence(sent, now);
    }

    /// The sequences to repair now, lowest first: ONE repair round, sealed as ONE control box when
    /// not empty (RFC 9002 loss detection run at the receiver, `rtt` being the current carrier's
    /// estimator).
    pub fn repair_due(&mut self, now: u64, rtt: &dyn RttEstimate) -> Vec<u64> {
        let mut out: Vec<u64> = Vec::new();
        let explicit: Vec<u64> = std::mem::take(&mut self.repairs).into_iter().collect();
        for sequence in explicit {
            if sequence > self.delivered && !self.lost.contains(&sequence) {
                self.declare(sequence, &mut out);
            }
        }
        let loss_delay = rtt.loss_delay_ms();
        let pending: Vec<(u64, u64)> = self.gaps.iter().map(|(s, since)| (*s, *since)).collect();
        for (sequence, since) in pending {
            if sequence <= self.delivered || self.has_complete(sequence) {
                self.gaps.remove(&sequence);
            } else if sequence + PACKET_THRESHOLD <= self.highest_arrived
                || now.saturating_sub(since) as f64 >= loss_delay
            {
                self.declare(sequence, &mut out);
            }
        }
        let delivered = self.delivered;
        self.lost.retain(|sequence| *sequence > delivered);
        if !out.is_empty() {
            self.pto_armed_at = Some(now);
        } else if !self.lost.is_empty()
            && self
                .pto_armed_at
                .is_some_and(|armed| now.saturating_sub(armed) as f64 >= rtt.pto_ms() * 2f64.powi(self.pto_count as i32))
        {
            let probes: Vec<u64> = self
                .lost
                .iter()
                .copied()
                .filter(|sequence| !self.has_complete(*sequence))
                .take(PTO_PROBES)
                .collect();
            if !probes.is_empty() {
                out.extend(probes);
                self.pto_count += 1;
                self.pto_armed_at = Some(now);
            }
        }
        out.sort_unstable();
        out
    }

    fn declare(&mut self, sequence: u64, out: &mut Vec<u64>) {
        self.gaps.remove(&sequence);
        self.lost.insert(sequence);
        out.push(sequence);
    }

    /// The carrier changed (promotion or demotion): the resume point goes out at once, on the
    /// surviving carrier, with the selective ranges.
    pub fn carrier_changed(&mut self, now: u64) {
        self.force_ack = true;
        self.unacked_since.get_or_insert(now);
    }

    /// Complete records above the delivered point, as ascending ranges (at most
    /// `MAX_ACK_RANGES`, lowest first).
    fn held_ranges(&self) -> Vec<(u64, u64)> {
        let mut ranges: Vec<(u64, u64)> = Vec::new();
        for (sequence, slot) in &self.slots {
            if *sequence <= self.delivered || !slot.candidates.iter().any(Candidate::complete) {
                continue;
            }
            if let Some(last) = ranges.last_mut().filter(|last| *sequence == last.1 + 1) {
                last.1 = *sequence;
            } else if ranges.len() < MAX_ACK_RANGES {
                ranges.push((*sequence, *sequence));
            } else {
                break;
            }
        }
        ranges
    }

    /// The ack to send now, or `None` (RFC 9000 §13.2): after two accepted records, after
    /// max_ack_delay, or at once for a duplicate of a delivered record or a carrier change.
    pub fn ack_due(&self, now: u64) -> Option<AckDue> {
        if self.delivered == self.acked_through && !self.force_ack {
            return None;
        }
        if self.force_ack
            || self.unacked_records >= ACK_ELICITING_THRESHOLD
            || self.unacked_since.is_some_and(|since| now.saturating_sub(since) >= MAX_ACK_DELAY_MS)
        {
            return Some(AckDue { through: self.delivered, ranges: self.held_ranges() });
        }
        None
    }

    pub fn ack_sent(&mut self, through: u64) {
        self.acked_through = self.acked_through.max(through);
        self.unacked_records = 0;
        self.unacked_since = None;
        self.force_ack = false;
    }

    pub fn stats(&self) -> ReceiverStats {
        ReceiverStats {
            delivered_through: self.delivered,
            buffered_records: self.slots.len(),
            buffered_bytes: self.bytes,
            head_bytes: self.head_bytes(),
            future_bytes: self.bytes - self.head_bytes(),
            duplicates: self.duplicates,
            discarded: self.discarded,
            evicted: self.evicted,
        }
    }
}

/// A fresh carrier with no RTT sample (RFC 9002 §6.2.2): the estimator `repair_due` falls back to.
pub fn initial_rtt_estimate() -> PathMonitor {
    PathMonitor::new(0)
}
