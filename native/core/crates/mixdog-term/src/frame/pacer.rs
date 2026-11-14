//! The frame cadence: draw requests are coalesced and flushed at most once per [`TUI_FRAME_MS`], the way Ink's
//! `maxFps` throttle (leading and trailing edge) paced its renders, and each flushed frame is reported to a callback:
//! the render acknowledgement the transcript store waits for before it commits the next split.
//!
//! Time is passed in as milliseconds on any monotonic clock, so the logic is a plain state machine; the run loop owns
//! the timer and calls [`PacedFrames::poll`] when the delay it returned has passed.

use std::io::{self, Write};

use super::{CursorPos, FrameWriter, Grid};

/// The render rate of the terminal UI (`TUI_RENDER_FPS` of `render-timing.mjs`).
pub const TUI_RENDER_FPS: u64 = 120;

/// The cadence in milliseconds: Ink's `Math.ceil(1000 / maxFps)`, 9.
pub const TUI_FRAME_MS: u64 = 1000_u64.div_ceil(TUI_RENDER_FPS);

/// What the pacer says to do now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pace {
    /// Nothing was requested.
    Idle,
    /// A frame is due in this many milliseconds.
    Wait(u64),
    /// Flush now.
    Flush,
}

/// Throttle with a leading and a trailing edge: the first request after a quiet frame flushes at once, requests inside
/// a frame wait for the frame's end and share one flush.
#[derive(Clone, Copy, Debug)]
pub struct FramePacer {
    frame_ms: u64,
    last_flush: Option<u64>,
    requested: bool,
}

impl Default for FramePacer {
    fn default() -> Self {
        Self::new(TUI_FRAME_MS)
    }
}

impl FramePacer {
    pub const fn new(frame_ms: u64) -> Self {
        Self { frame_ms, last_flush: None, requested: false }
    }

    /// A draw was requested.
    pub fn request(&mut self) {
        self.requested = true;
    }

    pub fn pace(&self, now_ms: u64) -> Pace {
        if !self.requested {
            return Pace::Idle;
        }
        let Some(last) = self.last_flush else { return Pace::Flush };
        let due = last.saturating_add(self.frame_ms);
        if now_ms >= due { Pace::Flush } else { Pace::Wait(due - now_ms) }
    }

    /// A frame was flushed at `now_ms`.
    pub fn flushed(&mut self, now_ms: u64) {
        self.requested = false;
        self.last_flush = Some(now_ms);
    }

    /// When the last frame was flushed.
    pub fn last_flush(&self) -> Option<u64> {
        self.last_flush
    }
}

/// What a flushed frame reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameAck {
    /// The 1-based number of the flushed frame.
    pub seq: u64,
    /// The clock reading at the flush.
    pub at_ms: u64,
    /// Bytes written (0 when the frame equalled the screen).
    pub bytes: usize,
}

type OnFlush = Box<dyn FnMut(FrameAck) + Send>;

/// A [`FrameWriter`] behind a [`FramePacer`].
pub struct PacedFrames<W: Write> {
    writer: FrameWriter<W>,
    pacer: FramePacer,
    pending: Option<(Grid, Option<CursorPos>)>,
    on_flush: OnFlush,
    seq: u64,
}

impl<W: Write> PacedFrames<W> {
    pub fn new(writer: FrameWriter<W>, on_flush: impl FnMut(FrameAck) + Send + 'static) -> Self {
        Self { writer, pacer: FramePacer::default(), pending: None, on_flush: Box::new(on_flush), seq: 0 }
    }

    pub fn writer(&self) -> &FrameWriter<W> {
        &self.writer
    }

    pub fn writer_mut(&mut self) -> &mut FrameWriter<W> {
        &mut self.writer
    }

    /// Asks for a frame. A request made while one is waiting replaces it. Returns the milliseconds until the frame is
    /// due when it was not flushed now.
    pub fn draw(&mut self, grid: Grid, cursor: Option<CursorPos>, now_ms: u64) -> io::Result<Option<u64>> {
        self.pending = Some((grid, cursor));
        self.pacer.request();
        self.poll(now_ms)
    }

    /// Flushes the waiting frame when it is due. Returns the milliseconds until it is, if it is not yet.
    pub fn poll(&mut self, now_ms: u64) -> io::Result<Option<u64>> {
        match self.pacer.pace(now_ms) {
            Pace::Idle => Ok(None),
            Pace::Wait(ms) => Ok(Some(ms)),
            Pace::Flush => {
                self.flush(now_ms)?;
                Ok(None)
            }
        }
    }

    /// Flushes the waiting frame now, whatever the cadence says (a frame that must reach the screen before the
    /// terminal is handed over).
    pub fn flush(&mut self, now_ms: u64) -> io::Result<()> {
        let Some((grid, cursor)) = self.pending.take() else { return Ok(()) };
        let stats = self.writer.write_frame(&grid, cursor)?;
        self.pacer.flushed(now_ms);
        self.acknowledge(now_ms, stats.bytes);
        Ok(())
    }

    /// Clears the screen and repaints the frame the screen holds, at once.
    pub fn force_full_repaint(&mut self, now_ms: u64) -> io::Result<()> {
        let stats = self.writer.force_full_repaint()?;
        self.pacer.flushed(now_ms);
        self.acknowledge(now_ms, stats.bytes);
        Ok(())
    }

    fn acknowledge(&mut self, now_ms: u64, bytes: usize) {
        self.seq += 1;
        (self.on_flush)(FrameAck { seq: self.seq, at_ms: now_ms, bytes });
    }

    pub fn into_inner(self) -> FrameWriter<W> {
        self.writer
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn the_cadence_is_ceil_of_a_thousand_over_the_rate() {
        assert_eq!(TUI_FRAME_MS, 9);
    }

    #[test]
    fn the_first_request_flushes_and_the_rest_wait_for_the_frame_end() {
        let mut pacer = FramePacer::default();
        assert_eq!(pacer.pace(0), Pace::Idle);
        pacer.request();
        assert_eq!(pacer.pace(100), Pace::Flush);
        pacer.flushed(100);
        pacer.request();
        assert_eq!(pacer.pace(103), Pace::Wait(6));
        pacer.request();
        assert_eq!(pacer.pace(108), Pace::Wait(1));
        assert_eq!(pacer.pace(109), Pace::Flush);
        pacer.flushed(109);
        assert_eq!(pacer.pace(500), Pace::Idle);
        pacer.request();
        assert_eq!(pacer.pace(500), Pace::Flush);
    }

    #[test]
    fn requests_inside_a_frame_share_one_flush_and_each_flush_is_acknowledged() {
        let acks = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&acks);
        let writer = FrameWriter::new(Vec::new(), 3);
        let mut frames = PacedFrames::new(writer, move |ack| seen.lock().unwrap().push(ack));
        let mut grid = Grid::new(4, 1);
        grid.put_glyph(0, 0, "a", 1, super::super::Style::default(), 0);
        assert_eq!(frames.draw(grid.clone(), None, 0).unwrap(), None);
        grid.put_glyph(1, 0, "b", 1, super::super::Style::default(), 0);
        assert_eq!(frames.draw(grid.clone(), None, 2).unwrap(), Some(7));
        grid.put_glyph(2, 0, "c", 1, super::super::Style::default(), 0);
        assert_eq!(frames.draw(grid, None, 4).unwrap(), Some(5));
        assert_eq!(frames.poll(8).unwrap(), Some(1));
        assert_eq!(frames.poll(9).unwrap(), None);
        let acks = acks.lock().unwrap();
        assert_eq!(acks.len(), 2);
        assert_eq!((acks[0].seq, acks[0].at_ms), (1, 0));
        assert_eq!((acks[1].seq, acks[1].at_ms), (2, 9));
        assert!(acks[1].bytes > 0);
    }
}
