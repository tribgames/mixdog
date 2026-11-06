//! A feed's ring of encoded frames, bounded by bytes (P §6.5 "Rings"): it evicts the oldest
//! whole frames, so `firstSeq` only advances. Each entry keeps the running byte total through
//! itself, so the replay test's byte sum is O(1) under the feed lock.

use std::collections::VecDeque;

use mixdog_core_api::feed::FeedFrame;

pub(super) struct Ring {
    limit: usize,
    entries: VecDeque<Entry>,
    /// Encoded bytes held: Σ frame lengths, ≤ `limit` between pushes.
    held: usize,
}

struct Entry {
    frame: FeedFrame,
    /// Bytes of every frame ever pushed, through this one.
    end: u64,
}

impl Entry {
    fn start(&self) -> u64 {
        self.end - self.frame.bytes.len() as u64
    }
}

/// The ring frames after a resume position, with their encoded byte total.
pub(super) struct Replay<'a> {
    pub bytes: usize,
    frames: std::collections::vec_deque::Iter<'a, Entry>,
}

impl<'a> Iterator for Replay<'a> {
    type Item = &'a FeedFrame;

    fn next(&mut self) -> Option<Self::Item> {
        self.frames.next().map(|entry| &entry.frame)
    }
}

impl Ring {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            entries: VecDeque::new(),
            held: 0,
        }
    }

    /// Appends `frame` (the feed's next seq) and evicts the oldest frames above the limit.
    pub fn push(&mut self, frame: FeedFrame) {
        let end = self.entries.back().map_or(0, |last| last.end) + frame.bytes.len() as u64;
        self.held += frame.bytes.len();
        self.entries.push_back(Entry { frame, end });
        while self.held > self.limit {
            let evicted = self
                .entries
                .pop_front()
                .expect("the ring holds the counted bytes");
            self.held -= evicted.frame.bytes.len();
        }
    }

    /// The frames `(after, head]` when every one of them is still held (P §6.3 condition 2):
    /// `after ≤ head` and `after + 1 ≥ firstSeq`. `head` is the feed's last seq; the ring's
    /// newest frame, if any, is `head`.
    pub fn after(&self, after: u64, head: u64) -> Option<Replay<'_>> {
        let first_seq = self
            .entries
            .front()
            .map_or(head + 1, |entry| entry.frame.seq);
        if after > head || after + 1 < first_seq {
            return None;
        }
        let skip = (after + 1 - first_seq) as usize;
        let bytes = match (self.entries.get(skip), self.entries.back()) {
            (Some(first), Some(last)) => (last.end - first.start()) as usize,
            _ => 0,
        };
        Some(Replay {
            bytes,
            frames: self.entries.range(skip..),
        })
    }

    /// Encoded bytes held.
    #[cfg(test)]
    pub fn held(&self) -> usize {
        self.held
    }
}
