//! A feed's ring of encoded frames and positioned unit deliveries, bounded by bytes (P §6.5 "Rings"):
//! frames and positioned deliveries keep independent `ring_bytes` budgets so positioned delivery
//! retention never reduces plain frame replay coverage. Each deque evicts its oldest whole entries,
//! so the eviction watermarks only advance. Each frame keeps the running plain byte total through
//! itself, so plain replay's byte sum is O(1) after binary search.

use std::collections::VecDeque;
use std::collections::vec_deque;
use std::iter::Peekable;
use std::sync::Arc;

use bytes::Bytes;
use mixdog_core_api::feed::FeedFrame;

pub(super) struct Ring {
    limit: usize,
    frames: VecDeque<RingFrame>,
    /// Encoded frame bytes held: Σ `frame.held_bytes()`, ≤ `limit` between pushes.
    frame_held: usize,
    /// Cumulative plain bytes (`frame.bytes.len()`) of every frame ever pushed.
    plain_total: u64,
    /// Highest `seq` of any evicted or dropped frame.
    evicted_frame_seq: Option<u64>,
    deliveries: VecDeque<DeliveredEntry>,
    /// Encoded delivery bytes held: Σ `delivered.held_bytes()`, ≤ `limit` between pushes.
    deliver_held: usize,
    /// Highest `(seq, id)` of any evicted or dropped delivery.
    evicted_deliver: Option<(u64, u64)>,
}

struct RingFrame {
    frame: FeedFrame,
    /// Cumulative plain bytes through this frame.
    end: u64,
}

pub(super) struct DeliveredEntry {
    pub id: u64,
    pub seq: u64,
    pub lineage: u64,
    pub ordinal: u64,
    pub position: Arc<str>,
    pub after: Option<Arc<str>>,
    pub insert: Option<Bytes>,
    pub replace: Option<Bytes>,
}

impl DeliveredEntry {
    pub fn held_bytes(&self) -> usize {
        self.insert.as_ref().map_or(0, Bytes::len) + self.replace.as_ref().map_or(0, Bytes::len)
    }
}

pub(super) enum PositionedEntry<'a> {
    Frame(&'a FeedFrame),
    Deliver(&'a DeliveredEntry),
}

/// The ring frames after a resume position, with their plain encoded byte total.
pub(super) struct Replay<'a> {
    pub bytes: usize,
    entries: vec_deque::Iter<'a, RingFrame>,
}

impl<'a> Iterator for Replay<'a> {
    type Item = &'a FeedFrame;

    fn next(&mut self) -> Option<Self::Item> {
        self.entries.next().map(|entry| &entry.frame)
    }
}

/// Frames `(after, head]` and deliveries `[after, head]` merged in chronological order
/// (`Frame(seq)` always precedes deliveries standing at `seq`).
pub(super) struct PositionedReplay<'a> {
    frames: Peekable<vec_deque::Iter<'a, RingFrame>>,
    deliveries: Peekable<vec_deque::Iter<'a, DeliveredEntry>>,
}

impl<'a> Iterator for PositionedReplay<'a> {
    type Item = PositionedEntry<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        match (self.frames.peek(), self.deliveries.peek()) {
            (Some(frame), Some(delivered)) => {
                if frame.frame.seq <= delivered.seq {
                    Some(PositionedEntry::Frame(&self.frames.next()?.frame))
                } else {
                    Some(PositionedEntry::Deliver(self.deliveries.next()?))
                }
            }
            (Some(_), None) => Some(PositionedEntry::Frame(&self.frames.next()?.frame)),
            (None, Some(_)) => Some(PositionedEntry::Deliver(self.deliveries.next()?)),
            (None, None) => None,
        }
    }
}

impl Ring {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            frames: VecDeque::new(),
            frame_held: 0,
            plain_total: 0,
            evicted_frame_seq: None,
            deliveries: VecDeque::new(),
            deliver_held: 0,
            evicted_deliver: None,
        }
    }

    fn record_evicted_frame(&mut self, seq: u64) {
        self.evicted_frame_seq = Some(self.evicted_frame_seq.map_or(seq, |prev| prev.max(seq)));
    }

    fn record_evicted_deliver(&mut self, delivered: &DeliveredEntry) {
        let next = (delivered.seq, delivered.id);
        self.evicted_deliver = Some(self.evicted_deliver.map_or(next, |prev| prev.max(next)));
    }

    /// Appends `frame` (the feed's next seq) and evicts the oldest frames above `limit`.
    pub fn push(&mut self, frame: FeedFrame) {
        self.plain_total += frame.bytes.len() as u64;
        self.frame_held += frame.held_bytes();
        self.frames.push_back(RingFrame { frame, end: self.plain_total });
        while self.frame_held > self.limit {
            let evicted = self.frames.pop_front().expect("the ring holds the counted bytes");
            self.record_evicted_frame(evicted.frame.seq);
            self.frame_held -= evicted.frame.held_bytes();
        }
    }

    /// Appends a positioned unit delivery at the feed's current seq and evicts the oldest
    /// deliveries above `limit` without affecting frame retention.
    pub fn push_delivered(&mut self, delivered: DeliveredEntry) {
        self.deliver_held += delivered.held_bytes();
        self.deliveries.push_back(delivered);
        while self.deliver_held > self.limit {
            let evicted = self.deliveries.pop_front().expect("the delivery ring holds the counted bytes");
            self.record_evicted_deliver(&evicted);
            self.deliver_held -= evicted.held_bytes();
        }
    }

    /// Drops entries through `seq` and advances the eviction watermarks.
    pub fn drop_through(&mut self, seq: u64) {
        while self.frames.front().is_some_and(|entry| entry.frame.seq <= seq) {
            let dropped = self.frames.pop_front().expect("the front was just seen");
            self.record_evicted_frame(dropped.frame.seq);
            self.frame_held -= dropped.frame.held_bytes();
        }
        while self.deliveries.front().is_some_and(|entry| entry.seq <= seq) {
            let dropped = self.deliveries.pop_front().expect("the front was just seen");
            self.record_evicted_deliver(&dropped);
            self.deliver_held -= dropped.held_bytes();
        }
    }

    /// [`Self::drop_through`] for a feed gone quiet: the space the dropped entries took goes too.
    pub fn rest(&mut self, seq: u64) {
        self.drop_through(seq);
        self.frames.shrink_to_fit();
        self.deliveries.shrink_to_fit();
    }

    /// The frames `(after, head]` when every one of them is still held (P §6.3 condition 2):
    /// `after ≤ head` and no frame after `after` has been evicted.
    pub fn after(&self, after: u64, head: u64) -> Option<Replay<'_>> {
        if after > head || self.evicted_frame_seq.is_some_and(|evicted| after < evicted) {
            return None;
        }
        let skip = self.frames.partition_point(|entry| entry.frame.seq <= after);
        let bytes = self.frames.get(skip).map_or(0, |first| (self.plain_total - (first.end - first.frame.bytes.len() as u64)) as usize);
        Some(Replay { bytes, entries: self.frames.range(skip..) })
    }

    /// Frames `(after, head]` and deliveries `[after, head]` in chronological order when every
    /// frame `(after, head]` and every delivery at `seq >= after` with `id >= floor_deliver_id` is still held.
    pub fn positioned_after(&self, after: u64, head: u64, floor_deliver_id: u64) -> Option<PositionedReplay<'_>> {
        if after > head || self.evicted_frame_seq.is_some_and(|evicted| after < evicted) {
            return None;
        }
        if self.evicted_deliver.is_some_and(|(ev_seq, ev_id)| ev_seq >= after && ev_id >= floor_deliver_id) {
            return None;
        }
        let frame_skip = self.frames.partition_point(|entry| entry.frame.seq <= after);
        let deliver_skip = self.deliveries.partition_point(|entry| entry.seq < after);
        Some(PositionedReplay { frames: self.frames.range(frame_skip..).peekable(), deliveries: self.deliveries.range(deliver_skip..).peekable() })
    }

    /// Lowest seq still present in the delivery ring, or `head` when empty.
    pub fn min_retained_deliver_seq(&self, head: u64) -> u64 {
        self.deliveries.front().map_or(head, |entry| entry.seq)
    }

    /// Encoded bytes held across frames and deliveries.
    #[cfg(test)]
    pub fn held(&self) -> usize {
        self.frame_held + self.deliver_held
    }
}
