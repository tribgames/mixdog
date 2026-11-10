//! The output of a terminal tab as Node's relay push lane sent it to a phone (`remote-relay-push-lanes.ts`, a `TerminalDataBufferer` with
//! `{ delayMs: 16, leadingEdge: true }` and the default 256 KiB high watermark, every frame acknowledged as it is sent): the first output
//! after 16 ms of quiet goes at once, output within 16 ms of the last frame waits until 16 ms after it and goes as one frame, and a frame
//! carries at most 256 Ki UTF-16 units (more is sent as several frames at once). Nothing else flushes it: neither the exit nor a dispose
//! (the relay lane never `release`s a tab, terminal-data-buffer.ts), so an exit line waits for its 16 ms like any output.
//!
//! The window's own terminal IPC (`ipc-terminal.ts`, 5 ms, flow control by the renderer's acknowledgements) sits in the desktop's main
//! process over the raw `process:<tab>` feed and is unchanged; this is the relay's rule, on the feed only a phone reads.
//!
//! A pure state machine: time is what the caller passes, so a test moves it explicitly.

use std::time::Duration;

use tokio::time::Instant;

/// Node's relay delay (`delayMs: 16`).
pub(crate) const RELAY_DELAY: Duration = Duration::from_millis(16);
/// Node's default high watermark (`256 * 1024` characters, UTF-16 units): the most one frame carries.
pub(crate) const RELAY_FRAME_UNITS: usize = 256 * 1024;

#[derive(Default)]
pub(crate) struct RelayBuffer {
    pending: Vec<u8>,
    last: Option<Instant>,
    due: Option<Instant>,
}

impl RelayBuffer {
    /// Output arrived at `now`: the frames to send at once (none while it waits).
    pub(crate) fn push(&mut self, bytes: &[u8], now: Instant) -> Vec<Vec<u8>> {
        if bytes.is_empty() {
            return Vec::new();
        }
        if !self.pending.is_empty() {
            self.pending.extend_from_slice(bytes);
            return Vec::new();
        }
        self.pending.extend_from_slice(bytes);
        let wait = self.last.map_or(Duration::ZERO, |last| RELAY_DELAY.saturating_sub(now.saturating_duration_since(last)));
        if wait.is_zero() {
            return self.flush(now);
        }
        self.due = Some(now + wait);
        Vec::new()
    }

    /// When the waiting output is due; `None` while nothing waits.
    pub(crate) fn due(&self) -> Option<Instant> {
        self.due
    }

    /// Sends what waits, at `now`.
    pub(crate) fn flush(&mut self, now: Instant) -> Vec<Vec<u8>> {
        self.due = None;
        if self.pending.is_empty() {
            return Vec::new();
        }
        self.last = Some(now);
        split_units(&std::mem::take(&mut self.pending), RELAY_FRAME_UNITS)
    }
}

/// `bytes` in pieces of at most `limit` UTF-16 units of their text (an invalid sequence counts as the one U+FFFD a decoder makes of it),
/// cut between characters.
fn split_units(bytes: &[u8], limit: usize) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let (mut start, mut units, mut at) = (0usize, 0usize, 0usize);
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            let width = c.len_utf16();
            if units + width > limit && at > start {
                frames.push(bytes[start..at].to_vec());
                (start, units) = (at, 0);
            }
            units += width;
            at += c.len_utf8();
        }
        if !chunk.invalid().is_empty() {
            if units + 1 > limit && at > start {
                frames.push(bytes[start..at].to_vec());
                (start, units) = (at, 0);
            }
            units += 1;
            at += chunk.invalid().len();
        }
    }
    if at > start {
        frames.push(bytes[start..at].to_vec());
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's relay rule at its edges (terminal-data-buffer.ts with `{ delayMs: 16, leadingEdge: true }`): the first output goes at once,
    /// output within 16 ms of a frame waits until 16 ms after it and joins whatever else arrives meanwhile, and output after 16 ms of quiet
    /// goes at once again. Time moves only as the test says.
    #[test]
    fn output_goes_at_once_after_quiet_and_joins_within_sixteen_ms() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut buffer = RelayBuffer::default();
        assert_eq!(buffer.push(b"echo", at(0)), vec![b"echo".to_vec()], "the first output goes at once");
        assert_eq!(buffer.push(b"out", at(5)), Vec::<Vec<u8>>::new(), "within 16 ms of a frame it waits");
        assert_eq!(buffer.due(), Some(at(16)), "until 16 ms after the frame");
        assert_eq!(buffer.push(b"put", at(10)), Vec::<Vec<u8>>::new());
        assert_eq!(buffer.due(), Some(at(16)), "more output keeps the time it is due");
        assert_eq!(buffer.flush(at(16)), vec![b"output".to_vec()], "as one frame");
        assert_eq!(buffer.due(), None);
        assert_eq!(buffer.push(b"x", at(31)), Vec::<Vec<u8>>::new(), "15 ms after the last frame it waits");
        assert_eq!(buffer.due(), Some(at(32)));
        assert_eq!(buffer.flush(at(32)), vec![b"x".to_vec()]);
        assert_eq!(buffer.push(b"y", at(48)), vec![b"y".to_vec()], "16 ms after the last frame it goes at once");
    }

    /// A frame carries at most 256 Ki UTF-16 units; more goes as several frames at once, cut between characters.
    #[test]
    fn a_frame_carries_at_most_the_high_watermark() {
        let start = Instant::now();
        let mut buffer = RelayBuffer::default();
        let _ = buffer.push(b"a", start);
        let mut text = "b".repeat(RELAY_FRAME_UNITS - 1);
        text.push('\u{1F600}');
        text.push_str("cc");
        let _ = buffer.push(text.as_bytes(), start + Duration::from_millis(1));
        let frames = buffer.flush(start + RELAY_DELAY);
        let lengths: Vec<usize> = frames.iter().map(|frame| String::from_utf8_lossy(frame).encode_utf16().count()).collect();
        assert_eq!(lengths, vec![RELAY_FRAME_UNITS - 1, 4], "the non-BMP character that would cross the bound starts the next frame");
        assert_eq!(frames.concat(), text.as_bytes());
    }
}
