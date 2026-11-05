//! The sender stream core (`RemoteTransportSender`): sequence, retain, ack, retransmit.
//! Pure: time is passed in.

use std::collections::BTreeMap;
use std::collections::HashMap;

use super::consts::{
    BUFFER_LOW_BYTES, BULK_OUTSTANDING_BYTES, MAX_OUTSTANDING_BYTES, MAX_RECORD_BYTES, MEDIA_RECORD_MAX_BYTES,
    MEDIA_STREAM_CREDIT_BYTES, RECORD_EXPIRY_MS, record_charge,
};
use super::control::{Ack, Authenticated, Repair};
use super::frame::box_sequence;
use super::TransportError;

/// A carrier instance: `relay`, or `direct:<connectionId>`.
pub type CarrierId = String;

struct Retained {
    sequence: u64,
    box_bytes: Vec<u8>,
    /// Media stream id for bulk records.
    stream: Option<String>,
    /// Carrier it was last handed to; `None` while never sent.
    carrier: Option<CarrierId>,
    pending: bool,
    resend: bool,
    /// A selective ack says the receiver already holds it complete.
    held: bool,
    /// Control sequence of the latest repair for it (0: none).
    repaired_by: u64,
    /// The carrier's handed-over byte count once this record was handed to it.
    handed_end: usize,
    charge: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SenderStats {
    pub next_sequence: u64,
    pub acked_through: u64,
    pub retained_records: usize,
    pub outstanding_bytes: usize,
    pub bulk_bytes: usize,
    pub retransmits: u64,
}

/// What a record is, for admission: `stream` marks a media adapter (bulk) record of that stream;
/// `buffered_amount` is the current carrier's queue.
#[derive(Clone, Debug, Default)]
pub struct Admission<'a> {
    pub stream: Option<&'a str>,
    pub buffered_amount: usize,
}

/// A record due for a carrier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Due {
    pub sequence: u64,
    pub box_bytes: Vec<u8>,
}

pub struct Sender {
    retained: BTreeMap<u64, Retained>,
    stream_bytes: HashMap<String, usize>,
    expected: u64,
    acked: u64,
    highest_sent: u64,
    bytes: usize,
    bulk_bytes: usize,
    retransmits: u64,
    progress_at: Option<u64>,
    /// Re-sends after a carrier failure wait until then (fractional, as a PTO is), or for an ack.
    hold_until: Option<f64>,
    pto_armed_at: Option<u64>,
    pto_count: u32,
    control_seen: u64,
    resume_after: u64,
    handed: HashMap<CarrierId, usize>,
}

impl Sender {
    pub fn new() -> Self {
        Self {
            retained: BTreeMap::new(),
            stream_bytes: HashMap::new(),
            expected: 1,
            acked: 0,
            highest_sent: 0,
            bytes: 0,
            bulk_bytes: 0,
            retransmits: 0,
            progress_at: None,
            hold_until: None,
            pto_armed_at: None,
            pto_count: 0,
            control_seen: 0,
            resume_after: 0,
            handed: HashMap::new(),
        }
    }

    /// Whether a new record may be sealed now. Room for its largest possible size is reserved. A
    /// bulk record is admitted only while the carrier queue is at or below the low-water mark,
    /// the bulk share has room and its stream has credit.
    pub fn can_admit(&self, admission: &Admission<'_>) -> bool {
        let size = if admission.stream.is_none() { MAX_RECORD_BYTES } else { MEDIA_RECORD_MAX_BYTES };
        if self.bytes + size > MAX_OUTSTANDING_BYTES {
            return false;
        }
        let Some(stream) = admission.stream else { return true };
        admission.buffered_amount <= BUFFER_LOW_BYTES
            && self.bulk_bytes + size <= BULK_OUTSTANDING_BYTES
            && self.stream_bytes.get(stream).copied().unwrap_or(0) + size <= MEDIA_STREAM_CREDIT_BYTES
    }

    /// The sequence the next sealed box must carry. A refusal before sealing leaves it unchanged.
    pub fn next_sequence(&self) -> u64 {
        self.expected
    }

    /// Takes one sealed box. Call only after `can_admit` with the same admission said yes.
    pub fn push(&mut self, box_bytes: Vec<u8>, admission: &Admission<'_>) -> Result<u64, TransportError> {
        let sequence = box_sequence(&box_bytes)?;
        if sequence != self.expected {
            return Err(TransportError::invalid(&format!("sender sequence {sequence}, expected {}", self.expected)));
        }
        if box_bytes.len() > MAX_RECORD_BYTES {
            return Err(TransportError::invalid("record size"));
        }
        let charge = record_charge(box_bytes.len());
        if self.bytes + charge > MAX_OUTSTANDING_BYTES {
            return Err(TransportError::invalid("sender window"));
        }
        let stream = admission.stream.map(str::to_owned);
        if let Some(stream) = &stream {
            if box_bytes.len() > MEDIA_RECORD_MAX_BYTES {
                return Err(TransportError::invalid("bulk record size"));
            }
            let held = self.stream_bytes.get(stream).copied().unwrap_or(0);
            if self.bulk_bytes + charge > BULK_OUTSTANDING_BYTES || held + charge > MEDIA_STREAM_CREDIT_BYTES {
                return Err(TransportError::invalid("bulk credit"));
            }
            self.stream_bytes.insert(stream.clone(), held + charge);
            self.bulk_bytes += charge;
        }
        self.retained.insert(
            sequence,
            Retained {
                sequence,
                box_bytes,
                stream,
                carrier: None,
                pending: true,
                resend: false,
                held: false,
                repaired_by: 0,
                handed_end: 0,
                charge,
            },
        );
        self.bytes += charge;
        self.expected += 1;
        Ok(sequence)
    }

    /// Records to hand to the current carrier now, in sequence order: first sends, plus re-sends
    /// once the post-failure hold ended, minus records a selective ack says the receiver holds.
    /// `budget_bytes` is the room the carrier has; the first record is always offered when there
    /// is any.
    pub fn due(&self, now: u64, budget_bytes: f64) -> Vec<Due> {
        let holding = self.hold_until.is_some_and(|until| (now as f64) < until);
        let mut out: Vec<Due> = Vec::new();
        let mut used = 0.0;
        for entry in self.retained.values() {
            if !entry.pending || (entry.resend && (holding || entry.held)) {
                continue;
            }
            if !out.is_empty() && used + entry.box_bytes.len() as f64 > budget_bytes {
                break;
            }
            if budget_bytes <= 0.0 {
                break;
            }
            out.push(Due { sequence: entry.sequence, box_bytes: entry.box_bytes.clone() });
            used += entry.box_bytes.len() as f64;
        }
        out
    }

    /// The carrier accepted the whole record (all of its messages).
    pub fn mark_sent(&mut self, sequence: u64, carrier: &str, now: u64) {
        let Some(entry) = self.retained.get_mut(&sequence) else { return };
        if entry.resend {
            self.retransmits += 1;
        }
        entry.pending = false;
        entry.resend = false;
        entry.carrier = Some(carrier.to_owned());
        let handed = self.handed.get(carrier).copied().unwrap_or(0) + entry.box_bytes.len();
        self.handed.insert(carrier.to_owned(), handed);
        entry.handed_end = handed;
        self.progress_at.get_or_insert(now);
        self.pto_armed_at = Some(now);
        self.highest_sent = self.highest_sent.max(sequence);
    }

    /// RFC 9002 §6.2 probe timeout, at the sender: true when records sent and unacked have seen
    /// neither a send nor an ack for `pto × 2^pto_count`. The caller then sends ONE probe: a ping
    /// whose `sent` is `probe_through`.
    pub fn probe_due(&mut self, now: u64, pto: f64) -> bool {
        let Some(armed) = self.pto_armed_at else { return false };
        if self.highest_sent <= self.acked {
            return false;
        }
        if (now.saturating_sub(armed) as f64) < pto * 2f64.powi(self.pto_count as i32) {
            return false;
        }
        self.pto_count += 1;
        self.pto_armed_at = Some(now);
        true
    }

    /// The highest sequence whose bytes have certainly left `carrier`'s queue: bytes handed to it
    /// minus its `buffered_amount`.
    pub fn probe_through(&self, carrier: &str, buffered_amount: usize) -> u64 {
        let drained = self.handed.get(carrier).copied().unwrap_or(0) as i64 - buffered_amount as i64;
        let mut through = self.acked;
        for entry in self.retained.values() {
            if entry.carrier.as_deref() == Some(carrier) && !entry.pending && entry.handed_end as i64 <= drained {
                through = through.max(entry.sequence);
            }
        }
        through
    }

    /// A carrier was demoted or closed: what was last handed to it becomes a re-send for the next
    /// carrier, held for `hold_ms` (one PTO of the surviving carrier) or until an ack newer than
    /// every control message observed before this point arrives.
    pub fn carrier_failed(&mut self, carrier: &str, now: u64, hold_ms: f64) -> usize {
        let mut count = 0;
        for entry in self.retained.values_mut() {
            if entry.carrier.as_deref() != Some(carrier) || entry.pending {
                continue;
            }
            entry.pending = true;
            entry.resend = true;
            count += 1;
        }
        self.handed.remove(carrier);
        if count > 0 {
            self.hold_until = Some(now as f64 + hold_ms.max(0.0));
            self.resume_after = self.control_seen;
        }
        count
    }

    /// The receiver discarded, evicted or never got `sequences`: send them again at once. Returns
    /// how many were re-queued.
    pub fn repair(&mut self, message: &Authenticated<Repair>) -> usize {
        let control_sequence = message.control_sequence;
        self.control_seen = self.control_seen.max(control_sequence);
        let mut count = 0;
        for sequence in &message.message.sequences {
            // A forged chunk for a record not yet sent can be evicted at the receiver and asked
            // for: nothing to repair, and no reason to end the session.
            let entry = if *sequence <= self.highest_sent { self.retained.get_mut(sequence) } else { None };
            let Some(entry) = entry else { continue };
            entry.repaired_by = entry.repaired_by.max(control_sequence);
            entry.pending = true;
            entry.resend = true;
            entry.held = false;
            count += 1;
        }
        count
    }

    fn release(&mut self, sequence: u64) -> bool {
        let Some(entry) = self.retained.remove(&sequence) else { return false };
        self.bytes -= entry.charge;
        if let Some(stream) = entry.stream {
            self.bulk_bytes -= entry.charge;
            let left = self.stream_bytes.get(&stream).copied().unwrap_or(0).saturating_sub(entry.charge);
            if left > 0 {
                self.stream_bytes.insert(stream, left);
            } else {
                self.stream_bytes.remove(&stream);
            }
        }
        true
    }

    /// Applies an ack that came out of an authenticated control box. An ack naming a record never
    /// sent is refused. Only `through` releases buffers; `ranges` only spare re-sends, and only
    /// for records not repaired by a LATER control message. Returns how many records it released.
    pub fn acknowledge(&mut self, ack: &Authenticated<Ack>, now: u64) -> Result<usize, TransportError> {
        let control_sequence = ack.control_sequence;
        let message = &ack.message;
        if message.through > self.highest_sent || message.ranges.iter().any(|(_, last)| *last > self.highest_sent) {
            return Err(TransportError::invalid("ack (beyond sent)"));
        }
        self.control_seen = self.control_seen.max(control_sequence);
        if control_sequence > self.resume_after {
            self.hold_until = None;
        }
        for (first, last) in &message.ranges {
            for sequence in (*first).max(self.acked + 1)..=*last {
                if let Some(entry) = self.retained.get_mut(&sequence) {
                    if control_sequence > entry.repaired_by {
                        entry.held = true;
                    }
                }
            }
        }
        if message.through <= self.acked {
            return Ok(0);
        }
        let mut released = 0;
        for sequence in self.acked + 1..=message.through {
            if self.release(sequence) {
                released += 1;
            }
        }
        self.acked = message.through;
        self.progress_at = if self.retained.is_empty() { None } else { Some(now) };
        self.pto_count = 0;
        self.pto_armed_at = Some(now);
        Ok(released)
    }

    /// True once records are outstanding and no ack has advanced for `RECORD_EXPIRY_MS`: the
    /// caller must end the session and fail unacked calls as ambiguous.
    pub fn expired(&self, now: u64) -> bool {
        !self.retained.is_empty() && self.progress_at.is_some_and(|at| now.saturating_sub(at) >= RECORD_EXPIRY_MS)
    }

    pub fn stats(&self) -> SenderStats {
        SenderStats {
            next_sequence: self.expected,
            acked_through: self.acked,
            retained_records: self.retained.len(),
            outstanding_bytes: self.bytes,
            bulk_bytes: self.bulk_bytes,
            retransmits: self.retransmits,
        }
    }
}
