//! The input pipeline: bytes from the terminal become [`InputEvent`]s.
//!
//! Three layers of the Ink fork meet here. The UTF-8 stream decoding Node's stdin applies; the tokenizer
//! ([`super::termio`]) and the keypress pipeline built on it (`termio-keypress.js`): bracketed-paste accumulation,
//! terminal-response replies (dropped, nothing listens for them), SGR and X10 mouse reports, orphaned mouse tails and
//! ordinary keypresses; and the stdin handling of the fork's `App.js`: a chunk that is one bare ESC is a cancel gesture
//! delivered at once, any other partial escape sequence waits 20 ms for its continuation and is then delivered as it
//! stands.

use std::time::{Duration, Instant};

use super::keypress::{KeyFlags, Scanner, decode_key};
use super::mouse::{self, MouseReport, WheelDirection};
use super::termio::{PASTE_END, PASTE_START, TokenKind, Tokenizer};

/// How long a partial escape sequence waits for its continuation before it is delivered as typed.
pub const PENDING_ESCAPE_FLUSH: Duration = Duration::from_millis(20);

/// One thing the terminal said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputEvent {
    /// A keypress, or a run of typed text: the `(input, key)` pair of the fork's `useInput`.
    Key { input: String, key: KeyFlags },
    /// A bracketed paste, whole (possibly empty). ESC bytes and line breaks inside it are kept as sent.
    Paste(String),
    /// An SGR or X10 wheel report, or an SGR click, drag or release.
    Mouse(MouseReport),
    /// Focus reporting (DEC mode 1004): `ESC [ I` is `true`, `ESC [ O` is `false`.
    Focus(bool),
}

/// What the keypress layer made of one token, before it is routed.
enum Parsed {
    /// A reply the terminal gave to one of our queries; no key produces one.
    Response,
    Click(MouseReport),
    Key { sequence: String, wheel: Option<WheelDirection> },
    Paste(String),
}

/// UTF-8 stream decoder with Node's `StringDecoder` behaviour: the bytes at the end of a read that look like the start of a
/// character the read did not finish (a lead byte of a two, three or four byte character with too few bytes after it)
/// wait for the next read, whether or not they could ever form a valid character; bytes that can never be valid become
/// U+FFFD.
#[derive(Debug, Default)]
struct Utf8Carry {
    pending: Vec<u8>,
}

/// How many bytes at the end of `bytes` `StringDecoder` holds back as an unfinished character.
fn unfinished_tail(bytes: &[u8]) -> usize {
    let mut buffered = 0;
    for &byte in bytes.iter().rev() {
        buffered += 1;
        if byte & 0xc0 == 0x80 {
            // A trailing byte: four of them, or no lead byte in the read at all, are invalid for the decoder to deal with.
            if buffered >= 4 || buffered == bytes.len() {
                return 0;
            }
            continue;
        }
        let wanted = match byte {
            b if b & 0xe0 == 0xc0 => 2,
            b if b & 0xf0 == 0xe0 => 3,
            b if b & 0xf8 == 0xf0 => 4,
            _ => return 0,
        };
        return if buffered >= wanted { 0 } else { buffered };
    }
    0
}

impl Utf8Carry {
    fn decode(&mut self, chunk: &[u8]) -> String {
        let mut buffer = std::mem::take(&mut self.pending);
        buffer.extend_from_slice(chunk);
        let keep = unfinished_tail(&buffer);
        let split = buffer.len() - keep;
        self.pending = buffer[split..].to_vec();
        String::from_utf8_lossy(&buffer[..split]).into_owned()
    }
}

/// Decoder of terminal input. Feed it what the terminal sent, in the order it came; it keeps what a sequence split across
/// reads needs. The caller wakes at [`Decoder::next_deadline`] and calls [`Decoder::flush_due`].
#[derive(Debug)]
pub struct Decoder {
    utf8: Utf8Carry,
    tokenizer: Tokenizer,
    in_paste: bool,
    paste_buffer: String,
    deadline: Option<Instant>,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Self {
        Self {
            utf8: Utf8Carry::default(),
            tokenizer: Tokenizer::new(true),
            in_paste: false,
            paste_buffer: String::new(),
            deadline: None,
        }
    }

    /// Decode one read of the terminal's input. `now` is the time of the read; a pending-escape flush that fell due before
    /// it is delivered first, as the fork's timer would have fired before the read.
    pub fn feed(&mut self, bytes: &[u8], now: Instant) -> Vec<InputEvent> {
        let mut out = self.flush_due(now);
        let text = self.utf8.decode(bytes);
        if text.is_empty() {
            return out;
        }
        self.deadline = None;
        let had_pending_escape = self.has_pending_escape();
        let bare_escape_chunk = !had_pending_escape && text == "\x1b";
        let units: Vec<u16> = text.encode_utf16().collect();
        let parsed = self.parse(Some(&units));
        dispatch_all(parsed, &mut out);
        if bare_escape_chunk && self.has_pending_escape() {
            out.extend(self.flush_pending_escape());
        }
        if self.has_pending_escape() {
            self.deadline = Some(now + PENDING_ESCAPE_FLUSH);
        }
        out
    }

    /// Deliver a pending partial escape sequence whose wait is over at `now`.
    pub fn flush_due(&mut self, now: Instant) -> Vec<InputEvent> {
        match self.deadline {
            Some(deadline) if now >= deadline => {
                self.deadline = None;
                self.flush_pending_escape()
            }
            _ => Vec::new(),
        }
    }

    /// When [`Decoder::flush_due`] next has something to deliver, if a partial escape sequence is waiting.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// Whether a bare ESC or a partial escape sequence is buffered. Not while a paste is open, and not while the paste
    /// start marker (or its penultimate prefix) is being assembled: those complete on their own and must never flush as
    /// literal input. Any other partial escape (`ESC [`, `ESC [ 2`, ...) arms the lone-ESC flush so it cannot buffer
    /// indefinitely.
    pub fn has_pending_escape(&self) -> bool {
        let pending = self.tokenizer.buffer();
        !self.in_paste
            && pending.first() == Some(&0x1b)
            && !starts_with_ascii(pending, PASTE_START)
            && !equals_ascii(pending, "\x1b[200")
    }

    /// Force the buffered incomplete sequence out as keys (typically a lone Escape).
    pub fn flush_pending_escape(&mut self) -> Vec<InputEvent> {
        if self.in_paste || self.tokenizer.buffer().first() != Some(&0x1b) {
            return Vec::new();
        }
        let parsed = self.parse(None);
        let mut out = Vec::new();
        dispatch_all(parsed, &mut out);
        self.deadline = None;
        out
    }

    /// Forget everything buffered: raw mode went off, or the terminal was handed to another program.
    pub fn reset(&mut self) {
        self.tokenizer.reset();
        self.in_paste = false;
        self.paste_buffer.clear();
        self.deadline = None;
    }

    /// Run a chunk (or, with `None`, a flush) through the tokenizer and turn the tokens into events.
    fn parse(&mut self, input: Option<&[u16]>) -> Vec<Parsed> {
        let tokens = match input {
            Some(units) => self.tokenizer.feed(units),
            None => self.tokenizer.flush(),
        };
        let mut events = Vec::new();
        for token in tokens {
            let value = String::from_utf16_lossy(&token.value);
            let is_text = token.kind == TokenKind::Text;
            if !is_text && value == PASTE_START {
                self.in_paste = true;
                self.paste_buffer.clear();
                continue;
            }
            if !is_text && value == PASTE_END {
                // An empty paste still emits an event so callers can react to it.
                self.in_paste = false;
                events.push(Parsed::Paste(std::mem::take(&mut self.paste_buffer)));
                continue;
            }
            if self.in_paste {
                self.paste_buffer.push_str(&value);
                continue;
            }
            if !is_text {
                events.push(parsed_for_sequence(value));
                continue;
            }
            if let Some(orphan) = parsed_for_orphan_tail(&value) {
                events.push(orphan);
                continue;
            }
            events.extend(split_editing_bytes(&value).into_iter().map(as_key));
        }
        // A paste left open at the end of a flush is delivered rather than dropped.
        if input.is_none() && self.in_paste && !self.paste_buffer.is_empty() {
            self.in_paste = false;
            events.push(Parsed::Paste(std::mem::take(&mut self.paste_buffer)));
        }
        events
    }
}

fn equals_ascii(units: &[u16], ascii: &str) -> bool {
    units.len() == ascii.len() && starts_with_ascii(units, ascii)
}

fn starts_with_ascii(units: &[u16], ascii: &str) -> bool {
    units.len() >= ascii.len() && units.iter().zip(ascii.bytes()).all(|(&unit, byte)| unit == u16::from(byte))
}

fn dispatch_all(parsed: Vec<Parsed>, out: &mut Vec<InputEvent>) {
    out.extend(parsed.into_iter().filter_map(dispatch));
}

/// Route one parsed event to what the caller sees.
fn dispatch(parsed: Parsed) -> Option<InputEvent> {
    match parsed {
        // Terminal query replies are not user input.
        Parsed::Response => None,
        Parsed::Click(report) => Some(InputEvent::Mouse(report)),
        Parsed::Paste(content) => Some(InputEvent::Paste(content)),
        Parsed::Key { sequence, wheel } => {
            if let Some(direction) = wheel {
                return mouse::wheel_report(&sequence, direction).map(InputEvent::Mouse);
            }
            match sequence.as_str() {
                "\x1b[I" => Some(InputEvent::Focus(true)),
                "\x1b[O" => Some(InputEvent::Focus(false)),
                _ => {
                    let (input, key) = decode_key(&sequence);
                    Some(InputEvent::Key { input, key })
                }
            }
        }
    }
}

fn as_key(sequence: String) -> Parsed {
    let wheel = mouse::wheel_direction(&sequence);
    Parsed::Key { sequence, wheel }
}

/// A non-paste sequence token becomes a response, a mouse event, or a key.
fn parsed_for_sequence(sequence: String) -> Parsed {
    if is_terminal_response(&sequence) {
        return Parsed::Response;
    }
    mouse_or_key(sequence)
}

fn mouse_or_key(sequence: String) -> Parsed {
    match mouse::click_report(&sequence) {
        Some(report) => Parsed::Click(report),
        None => as_key(sequence),
    }
}

/// An orphaned mouse tail: the ESC was flushed on its own as a lone Escape (a heavy render blocked past the pending-ESC
/// wait), so the continuation reached us as plain text. The X10 button slot is narrowed to the wheel range so ordinary
/// typing like `[MAX]` batched into one read is not mistaken for a click. Restores the ESC, or `None` when it is real text.
fn parsed_for_orphan_tail(text: &str) -> Option<Parsed> {
    if !is_orphan_sgr_tail(text) && !is_orphan_x10_tail(text) {
        return None;
    }
    Some(mouse_or_key(format!("\x1b{text}")))
}

/// `^\[<\d+;\d+;\d+[Mm]$`
fn is_orphan_sgr_tail(text: &str) -> bool {
    let mut sc = Scanner::new(text);
    sc.eat_str("[<")
        && sc.digits().is_some()
        && sc.eat(b';')
        && sc.digits().is_some()
        && sc.eat(b';')
        && sc.digits().is_some()
        && matches!(sc.peek(), Some(b'M' | b'm'))
        && {
            sc.i += 1;
            sc.at_end()
        }
}

/// `^\[M[\x60-\x7f][\x20-￿]{2}$`, over UTF-16 units.
fn is_orphan_x10_tail(text: &str) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    units.len() == 5
        && units[0] == 0x5b
        && units[1] == 0x4d
        && (0x60..=0x7f).contains(&units[2])
        && units[3] >= 0x20
        && units[4] >= 0x20
}

/// Cut a text run at every DEL/BS character. A held backspace arrives as one chunk (`\x7f\x7f\x7f`) and must land as three
/// key events, not one garbage key. Carriage returns and tabs stay inside their run.
fn split_editing_bytes(text: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut run = String::new();
    for character in text.chars() {
        if character != '\x7f' && character != '\x08' {
            run.push(character);
            continue;
        }
        if !run.is_empty() {
            pieces.push(std::mem::take(&mut run));
        }
        pieces.push(character.to_string());
    }
    if !run.is_empty() {
        pieces.push(run);
    }
    pieces
}

/// Whether a sequence token is a reply to a terminal query (DECRPM, DA1, DA2, kitty flags, cursor position, an OSC reply,
/// XTVERSION). These are syntactically distinguishable from keyboard input: no physical key produces `CSI ? ... c`.
fn is_terminal_response(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix("\x1b[") {
        if let Some(private) = rest.strip_prefix('?') {
            return is_decrpm(private)
                || is_device_attributes(private)
                || is_kitty_flags(private)
                || is_cursor_position(private);
        }
        return rest.strip_prefix('>').is_some_and(is_device_attributes);
    }
    if s.starts_with("\x1b]") {
        // `^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$`
        let mut sc = Scanner::new(s);
        if sc.eat_str("\x1b]") && sc.digits().is_some() && sc.eat(b';') {
            return ends_with_string_terminator(&s[sc.i..]);
        }
        return false;
    }
    if let Some(rest) = s.strip_prefix("\x1bP>|") {
        return ends_with_string_terminator(rest);
    }
    false
}

fn ends_with_string_terminator(s: &str) -> bool {
    s.ends_with('\x07') || s.ends_with("\x1b\\")
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `\d+;\d+` followed by `suffix`, as the whole of `s`.
fn is_number_pair_then(s: &str, suffix: &str) -> bool {
    s.strip_suffix(suffix)
        .and_then(|pair| pair.split_once(';'))
        .is_some_and(|(a, b)| all_digits(a) && all_digits(b))
}

/// `\d+;\d+$y`
fn is_decrpm(s: &str) -> bool {
    is_number_pair_then(s, "$y")
}

/// `[\d;]*c`
fn is_device_attributes(s: &str) -> bool {
    s.strip_suffix('c').is_some_and(|params| params.bytes().all(|b| b.is_ascii_digit() || b == b';'))
}

/// `\d+u`
fn is_kitty_flags(s: &str) -> bool {
    s.strip_suffix('u').is_some_and(all_digits)
}

/// `\d+;\d+R`
fn is_cursor_position(s: &str) -> bool {
    is_number_pair_then(s, "R")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&[u8]]) -> Vec<InputEvent> {
        let mut d = Decoder::new();
        let t = Instant::now();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(d.feed(chunk, t));
        }
        out.extend(d.flush_due(t + Duration::from_secs(1)));
        out
    }

    fn key(input: &str) -> InputEvent {
        InputEvent::Key { input: input.to_string(), key: KeyFlags::default() }
    }

    fn summary(events: &[InputEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| match e {
                InputEvent::Key { input, key } => format!("key:{input}:{}", key.escape),
                InputEvent::Paste(text) => format!("paste:{text}"),
                InputEvent::Mouse(r) => format!("mouse:{:?}:{}:{}", r.kind, r.col, r.row),
                InputEvent::Focus(on) => format!("focus:{on}"),
            })
            .collect()
    }

    #[test]
    fn text_and_korean_in_one_chunk() {
        assert_eq!(run(&["한글abc".as_bytes()]), vec![key("한글abc")]);
    }

    #[test]
    fn a_utf8_character_split_across_reads_is_held() {
        let bytes = "한".as_bytes();
        assert_eq!(run(&[&bytes[..1], &bytes[1..2], &bytes[2..]]), vec![key("한")]);
    }

    #[test]
    fn invalid_bytes_become_replacement_characters() {
        assert_eq!(run(&[b"a\xffb"]), vec![key("a\u{fffd}b")]);
    }

    #[test]
    fn held_backspace_is_three_keys() {
        let events = run(&[b"\x7f\x7f\x7f"]);
        assert_eq!(events.len(), 3);
        assert!(events.iter().all(|e| matches!(e, InputEvent::Key { key, .. } if key.backspace)));
    }

    #[test]
    fn a_sequence_split_across_reads_is_assembled() {
        let events = run(&[b"\x1b[", b"1;5", b"A"]);
        let [InputEvent::Key { key, input }] = events.as_slice() else { panic!("{events:?}") };
        assert!(key.up_arrow && key.ctrl && input.is_empty());
    }

    #[test]
    fn a_bare_escape_read_is_delivered_at_once() {
        let mut d = Decoder::new();
        let events = d.feed(b"\x1b", Instant::now());
        assert_eq!(summary(&events), vec!["key::true".to_string()]);
        assert!(d.next_deadline().is_none());
    }

    #[test]
    fn a_partial_sequence_waits_twenty_milliseconds() {
        let mut d = Decoder::new();
        let t = Instant::now();
        assert!(d.feed(b"\x1b[", t).is_empty());
        assert_eq!(d.next_deadline(), Some(t + PENDING_ESCAPE_FLUSH));
        assert!(d.flush_due(t + Duration::from_millis(19)).is_empty());
        let events = d.flush_due(t + Duration::from_millis(20));
        assert_eq!(events, vec![key("[")]);
        assert!(d.next_deadline().is_none());
    }

    #[test]
    fn a_continuation_before_the_deadline_completes_the_sequence() {
        let mut d = Decoder::new();
        let t = Instant::now();
        assert!(d.feed(b"\x1b", t).len() == 1, "bare ESC is delivered at once");
        assert!(d.feed(b"\x1b[", t).is_empty());
        let events = d.feed(b"A", t + Duration::from_millis(5));
        assert_eq!(events.len(), 1);
        assert!(d.next_deadline().is_none());
    }

    #[test]
    fn a_due_flush_is_delivered_before_the_next_read() {
        let mut d = Decoder::new();
        let t = Instant::now();
        assert!(d.feed(b"\x1b[", t).is_empty());
        let events = d.feed(b"x", t + Duration::from_millis(30));
        assert_eq!(events, vec![key("["), key("x")]);
    }

    #[test]
    fn the_paste_marker_prefix_never_flushes() {
        let mut d = Decoder::new();
        let t = Instant::now();
        assert!(d.feed(b"\x1b[200", t).is_empty());
        assert!(d.next_deadline().is_none());
        assert!(d.feed(b"~hi", t).is_empty());
        let events = d.feed(b"\x1b[201~", t);
        assert_eq!(events, vec![InputEvent::Paste("hi".to_string())]);
    }

    #[test]
    fn paste_keeps_escapes_and_crlf() {
        let events = run(&[b"\x1b[200~a\x1b[Ab\r\nc\x1b[201~z"]);
        assert_eq!(events, vec![InputEvent::Paste("a\x1b[Ab\r\nc".to_string()), key("z")]);
    }

    #[test]
    fn an_empty_paste_is_still_an_event() {
        assert_eq!(run(&[b"\x1b[200~\x1b[201~"]), vec![InputEvent::Paste(String::new())]);
    }

    #[test]
    fn paste_split_inside_the_end_marker() {
        let events = run(&[b"\x1b[200~ab\x1b[2", b"01~"]);
        assert_eq!(events, vec![InputEvent::Paste("ab".to_string())]);
    }

    #[test]
    fn mouse_reports() {
        let events = run(&[b"\x1b[<0;10;5M\x1b[<64;1;1M\x1b[<0;10;5m"]);
        assert_eq!(summary(&events), vec!["mouse:Press:9:4", "mouse:WheelUp:0:0", "mouse:Release:9:4"]);
    }

    #[test]
    fn terminal_responses_are_dropped() {
        let events = run(&[b"\x1b[?62;1c\x1b[?2004;1$y\x1b[?1u\x1b[?12;40R\x1b[>0;276;0c\x1b]11;rgb:0/0/0\x07\x1bP>|x\x1b\\"]);
        assert!(events.is_empty(), "{events:?}");
    }

    #[test]
    fn focus_reports() {
        assert_eq!(summary(&run(&[b"\x1b[I\x1b[O"])), vec!["focus:true", "focus:false"]);
    }

    #[test]
    fn an_orphaned_mouse_tail_is_restored() {
        let events = run(&[b"[<0;5;5M"]);
        assert_eq!(summary(&events), vec!["mouse:Press:4:4"]);
        // Ordinary typing is not mistaken for one.
        assert_eq!(run(&[b"[MAX]"]), vec![key("[MAX]")]);
    }

    #[test]
    fn x10_non_wheel_reports_are_keys() {
        let events = run(&[b"\x1b[M !!"]);
        assert_eq!(events, vec![key("[M !!")]);
    }

    #[test]
    fn reset_forgets_buffered_state() {
        let mut d = Decoder::new();
        let t = Instant::now();
        assert!(d.feed(b"\x1b[1;", t).is_empty());
        d.reset();
        assert!(d.next_deadline().is_none());
        assert_eq!(d.feed(b"a", t), vec![key("a")]);
    }

    #[test]
    fn response_patterns() {
        for reply in [
            "\x1b[?1;2c",
            "\x1b[?c",
            "\x1b[>c",
            "\x1b[?25;2$y",
            "\x1b[?7u",
            "\x1b[?1;1R",
            "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
            "\x1b]52;c;\x07",
            "\x1bP>|WezTerm\x07",
        ] {
            assert!(is_terminal_response(reply), "{reply:?}");
        }
        for key in ["\x1b[1;2c", "\x1b[?1;2", "\x1b[?25$y", "\x1b[97u", "\x1b]x;\x07", "\x1b]11;abc", "\x1bP>|x", "\x1b[1;1R"] {
            assert!(!is_terminal_response(key), "{key:?}");
        }
    }
}
