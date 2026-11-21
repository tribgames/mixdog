//! The live assistant stream of one REPL turn: batched writes to the terminal, the accumulated streamed text, the cursor flags the
//! tool cards and the final re-render depend on, and the erase that replaces the raw stream with rendered markdown.
//!
//! The sink holds the pending text and the instant the batch is due ([`StreamSink::next_deadline`]); the turn loop sleeps until
//! it and calls [`StreamSink::flush_due`].

use std::io;
use std::time::Duration;

use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_rt::time::Instant;

/// How long streamed text waits before it is written (`STREAM_WRITE_BATCH_MS`).
pub const STREAM_WRITE_BATCH: Duration = Duration::from_millis(8);

/// Where the REPL writes: the terminal's output stream.
pub trait Out {
    /// Writes `text` and hands it to the terminal.
    fn write_str(&mut self, text: &str) -> io::Result<()>;
    /// The terminal's width in columns (`out.columns`); none when the output is not a terminal.
    fn columns(&self) -> Option<usize>;
}

/// The terminal's width as the erase math reads it: a positive width, else 80.
fn columns_of(out: &dyn Out) -> usize {
    out.columns().filter(|columns| *columns > 0).unwrap_or(80)
}

/// `eraseStreamedBlock(out, streamedText)`: clears the raw streamed block so it can be printed again as markdown. The rows it
/// took are counted from the text's UTF-16 length per line and the terminal's width; if the count is off the transcript
/// stays readable.
pub fn erase_streamed_block(out: &mut dyn Out, streamed_text: &str) -> io::Result<()> {
    let columns = columns_of(out);
    let rows: usize = streamed_text.split('\n').map(|segment| utf16_len(segment).max(1).div_ceil(columns).max(1)).sum();
    // Column 0, then for each row taken: clear it and move up.
    let mut text = String::from("\r");
    for row in 0..rows {
        text.push_str("\x1b[2K");
        if row < rows - 1 {
            text.push_str("\x1b[1A");
        }
    }
    text.push('\r');
    out.write_str(&text)
}

/// The live stream of a turn.
#[derive(Debug)]
pub struct StreamSink {
    color: bool,
    batch: Duration,
    streamed_text: String,
    printed_any: bool,
    printed_tool_card: bool,
    /// After the blank line emitted at the start of a turn the cursor sits at a fresh line start. A tool card needs a
    /// leading newline only to break away from unterminated streamed text, never between consecutive cards.
    at_line_start: bool,
    pending: String,
    due: Option<Instant>,
    write_error: Option<io::Error>,
}

impl StreamSink {
    /// A sink under the colour decision `color` (`colorEnabled()`).
    pub fn new(color: bool) -> Self {
        Self::with_batch(color, STREAM_WRITE_BATCH)
    }

    pub fn with_batch(color: bool, batch: Duration) -> Self {
        Self {
            color,
            batch,
            streamed_text: String::new(),
            printed_any: false,
            printed_tool_card: false,
            at_line_start: true,
            pending: String::new(),
            due: None,
            write_error: None,
        }
    }

    /// `currentText()`: everything streamed so far.
    pub fn current_text(&self) -> &str {
        &self.streamed_text
    }

    pub fn printed_any(&self) -> bool {
        self.printed_any
    }

    pub fn printed_tool_card(&self) -> bool {
        self.printed_tool_card
    }

    /// When the pending text is due to be written; none when nothing waits.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.due
    }

    /// `flush()`: writes the pending text now. An error a timed flush met is reported here, once.
    pub fn flush(&mut self, out: &mut dyn Out) -> io::Result<()> {
        self.due = None;
        if let Some(error) = self.write_error.take() {
            return Err(error);
        }
        self.write_pending(out)
    }

    fn write_pending(&mut self, out: &mut dyn Out) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let text = std::mem::take(&mut self.pending);
        out.write_str(&text)
    }

    /// The timer of the batch: writes the pending text when it is due at `now`. A write that fails is kept for the next
    /// call that can report it.
    pub fn flush_due(&mut self, out: &mut dyn Out, now: Instant) {
        if self.due.is_some_and(|due| due <= now) {
            self.due = None;
            if let Err(error) = self.write_pending(out) {
                self.write_error = Some(error);
            }
        }
    }

    /// `pushDelta(chunk)`: a streamed chunk; it is written with the batch it joins.
    pub fn push_delta(&mut self, chunk: &str, now: Instant) -> io::Result<()> {
        if let Some(error) = self.write_error.take() {
            return Err(error);
        }
        self.printed_any = true;
        self.streamed_text.push_str(chunk);
        self.pending.push_str(chunk);
        if self.due.is_none() {
            self.due = Some(now + self.batch);
        }
        self.at_line_start = chunk.ends_with('\n');
        Ok(())
    }

    /// `writeToolCard(render)`: a card line after the text streamed before it.
    pub fn write_tool_card(&mut self, out: &mut dyn Out, card: &str) -> io::Result<()> {
        self.flush(out)?;
        self.printed_tool_card = true;
        let lead = if self.at_line_start { "" } else { "\n" };
        out.write_str(&format!("{lead}{card}\n"))?;
        self.at_line_start = true;
        Ok(())
    }

    /// `resetTail({ chars })`: drops the last `chars` UTF-16 units of the streamed text from the screen; false when refused (no
    /// count, no colour, or a tool card is already on screen).
    pub fn reset_tail(&mut self, out: &mut dyn Out, chars: usize) -> io::Result<bool> {
        if chars == 0 || !self.color || self.printed_tool_card {
            return Ok(false);
        }
        self.flush(out)?;
        let kept = utf16_len(&self.streamed_text).saturating_sub(chars);
        let remaining = slice_utf16(&self.streamed_text, kept);
        erase_streamed_block(out, &self.streamed_text)?;
        self.streamed_text = remaining;
        if !self.streamed_text.is_empty() {
            out.write_str(&self.streamed_text)?;
        }
        self.printed_any = !self.streamed_text.is_empty();
        self.at_line_start = self.streamed_text.is_empty() || self.streamed_text.ends_with('\n');
        Ok(true)
    }
}

/// An output that keeps what it was given, for the tests of this crate.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Capture {
    pub text: String,
    pub columns: Option<usize>,
}

#[cfg(test)]
impl Out for Capture {
    fn write_str(&mut self, text: &str) -> io::Result<()> {
        self.text.push_str(text);
        Ok(())
    }

    fn columns(&self) -> Option<usize> {
        self.columns
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_erase_counts_the_rows_of_every_line_by_the_width() {
        let mut out = Capture { columns: Some(4), ..Capture::default() };
        erase_streamed_block(&mut out, "abcdefgh\nx").expect("written");
        assert_eq!(out.text, "\r\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r");
        let mut unknown = Capture::default();
        erase_streamed_block(&mut unknown, "").expect("written");
        assert_eq!(unknown.text, "\r\x1b[2K\r");
    }

    #[test]
    fn text_is_written_with_its_batch_and_cards_break_away_from_an_open_line() {
        let mut out = Capture::default();
        let mut sink = StreamSink::new(false);
        let start = Instant::now();
        sink.push_delta("hel", start).expect("pushed");
        sink.push_delta("lo", start).expect("pushed");
        assert_eq!(out.text, "");
        assert_eq!(sink.next_deadline(), Some(start + STREAM_WRITE_BATCH));
        sink.flush_due(&mut out, start);
        assert_eq!(out.text, "");
        sink.flush_due(&mut out, start + STREAM_WRITE_BATCH);
        assert_eq!(out.text, "hello");
        assert_eq!(sink.next_deadline(), None);
        sink.write_tool_card(&mut out, "[a]").expect("card");
        sink.write_tool_card(&mut out, "[b]").expect("card");
        assert_eq!(out.text, "hello\n[a]\n[b]\n");
        assert_eq!((sink.current_text(), sink.printed_any(), sink.printed_tool_card()), ("hello", true, true));
    }

    #[test]
    fn a_tail_reset_is_refused_without_colour_or_after_a_card_and_otherwise_redraws_the_rest() {
        let start = Instant::now();
        let mut plain_out = Capture::default();
        let mut plain = StreamSink::new(false);
        plain.push_delta("abc", start).expect("pushed");
        assert!(!plain.reset_tail(&mut plain_out, 1).expect("reset"));

        let mut out = Capture { columns: Some(80), ..Capture::default() };
        let mut sink = StreamSink::new(true);
        sink.push_delta("abc\nde", start).expect("pushed");
        assert!(!sink.reset_tail(&mut out, 0).expect("reset"));
        assert!(sink.reset_tail(&mut out, 2).expect("reset"));
        assert_eq!(out.text, "abc\nde\r\x1b[2K\x1b[1A\x1b[2K\r".to_owned() + "abc\n");
        assert_eq!((sink.current_text(), sink.printed_any()), ("abc\n", true));
        assert!(sink.reset_tail(&mut out, 9).expect("reset"));
        assert_eq!((sink.current_text(), sink.printed_any()), ("", false));

        sink.write_tool_card(&mut out, "[t]").expect("card");
        assert!(!sink.reset_tail(&mut out, 1).expect("reset"));
    }

    /// An output that fails.
    struct Broken;

    impl Out for Broken {
        fn write_str(&mut self, _text: &str) -> io::Result<()> {
            Err(io::Error::other("closed"))
        }

        fn columns(&self) -> Option<usize> {
            None
        }
    }

    #[test]
    fn a_failed_timed_write_is_reported_once_by_the_next_call() {
        let start = Instant::now();
        let mut sink = StreamSink::new(false);
        sink.push_delta("x", start).expect("pushed");
        sink.flush_due(&mut Broken, start + STREAM_WRITE_BATCH);
        assert!(sink.push_delta("y", start).is_err());
        assert!(sink.push_delta("y", start).is_ok());
    }
}
