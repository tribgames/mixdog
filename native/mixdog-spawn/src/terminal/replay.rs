//! The replay window of a terminal tab (`TerminalReplayBuffer`). Positions are UTF-16 code
//! units, as in the Node twin: cursors a client holds must keep their meaning across the move.

use std::collections::VecDeque;

/// Characters a tab retains for reattach (`REPLAY_BUFFER_LIMIT`).
pub const REPLAY_BUFFER_LIMIT: usize = 200_000;

/// 1000 cursor units per wall-clock millisecond: a terminal would have to print over 1000
/// characters per millisecond of its lifetime to reach the epoch of one created after it.
pub fn cursor_epoch(now_ms: u64) -> u64 {
    now_ms.saturating_mul(1000)
}

pub struct ReplayBuffer {
    units: VecDeque<u16>,
    limit: usize,
    appended: u64,
    start_offset: u64,
}

/// Output after a cursor.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Replay {
    pub text: String,
    pub cursor: u64,
    /// The requested position had been trimmed away: the text starts at the oldest retained
    /// character instead.
    pub reset: bool,
}

impl ReplayBuffer {
    /// `start_offset` lets a recreated terminal begin above every cursor its predecessor
    /// issued, so those stale cursors fall below the oldest retained position.
    pub fn new(limit: usize, start_offset: u64) -> Self {
        Self {
            units: VecDeque::new(),
            limit: limit.max(1),
            appended: start_offset,
            start_offset,
        }
    }

    pub fn append(&mut self, text: &str) {
        let units: Vec<u16> = text.encode_utf16().collect();
        if units.is_empty() {
            return;
        }
        self.appended += units.len() as u64;
        if units.len() >= self.limit {
            self.units.clear();
            self.units.extend(&units[units.len() - self.limit..]);
            return;
        }
        self.units.extend(units);
        let overflow = self.units.len().saturating_sub(self.limit);
        self.units.drain(..overflow);
    }

    pub fn read(&self) -> String {
        let (a, b) = self.units.as_slices();
        String::from_utf16_lossy(&[a, b].concat())
    }

    /// The window as Node's string: a cut inside a non-BMP character leaves its low surrogate first, which Node keeps (it slices the JS
    /// string) and a Rust string cannot hold. That unit is returned on its own, the rest is the text after it. Appended text is always
    /// well formed, so a unit like that can only stand first.
    pub fn read_window(&self) -> (Option<u16>, String) {
        let (a, b) = self.units.as_slices();
        let units = [a, b].concat();
        match units.first() {
            Some(&lead) if (0xdc00..0xe000).contains(&lead) => (Some(lead), String::from_utf16_lossy(&units[1..])),
            _ => (None, String::from_utf16_lossy(&units)),
        }
    }

    /// Total characters ever appended, including the start offset (never decreases).
    pub fn cursor(&self) -> u64 {
        self.appended
    }

    /// This terminal's own output exceeded the retained window.
    pub fn trimmed(&self) -> bool {
        self.appended - self.start_offset > self.units.len() as u64
    }

    /// Output appended after `cursor`, without consuming anything.
    pub fn read_since(&self, cursor: u64) -> Replay {
        let oldest = self.appended - self.units.len() as u64;
        if cursor < oldest || cursor > self.appended {
            return Replay {
                text: self.read(),
                cursor: self.appended,
                reset: true,
            };
        }
        let skip = (cursor - oldest) as usize;
        let units: Vec<u16> = self.units.iter().skip(skip).copied().collect();
        Replay {
            text: String::from_utf16_lossy(&units),
            cursor: self.appended,
            reset: false,
        }
    }
}
