//! Terminal input split into text runs and raw escape sequences, per the ECMA-48 control-function shapes.
//!
//! This is a boundary scanner, not a semantic parser: it answers only "where does this escape sequence end", leaving
//! interpretation to the keypress layer. Each ESC found in the stream is handed to a family scanner that either reports
//! the end offset, reports that the stream ran out mid-sequence (so the tail is carried into the next feed), or rejects
//! the sequence, in which case the ESC and everything scanned after it degrade to plain text, as a terminal would show
//! them.
//!
//! The scan runs over UTF-16 code units, as the Ink fork's does over a JavaScript string: the X10 mouse payload is three
//! units, and a character outside the BMP is two.

/// Bracketed paste markers (DEC mode 2004).
pub const PASTE_START: &str = "\x1b[200~";
pub const PASTE_END: &str = "\x1b[201~";

const ESC: u16 = 0x1b;
const BEL: u16 = 0x07;

const OPEN_CSI: u16 = 0x5b; // [
const OPEN_OSC: u16 = 0x5d; // ]
const OPEN_DCS: u16 = 0x50; // P
const OPEN_APC: u16 = 0x5f; // _
const OPEN_SS3: u16 = 0x4f; // O
const STRING_TERMINATOR: u16 = 0x5c; // \ (as ESC \)
const X10_MOUSE_FINAL: u16 = 0x4d; // M

fn is_parameter(code: u16) -> bool {
    (0x30..=0x3f).contains(&code)
}
fn is_intermediate(code: u16) -> bool {
    (0x20..=0x2f).contains(&code)
}
fn is_control_final(code: u16) -> bool {
    (0x40..=0x7e).contains(&code)
}
fn is_escape_final(code: u16) -> bool {
    (0x30..=0x7e).contains(&code)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scan {
    Complete(usize),
    Pending,
    Literal(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Text,
    Sequence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub value: Vec<u16>,
}

/// X10 mouse payload plausibility. The legacy encoding puts three bytes after `CSI M`, each biased by 32, so every
/// present slot must be >= 0x20. A control byte in any slot means this `M` really is CSI DL (Delete Lines) or the head
/// of an adjacent sequence. Absent slots pass: the decision is revisited once more input arrives.
fn x10_payload_plausible(data: &[u16], at: usize) -> bool {
    (1..=3).all(|slot| {
        let index = at + slot;
        index >= data.len() || data[index] >= 0x20
    })
}

/// OSC / DCS / APC: opaque payload closed by BEL or ESC \.
fn scan_string_family(data: &[u16], from: usize) -> Scan {
    for (at, &code) in data.iter().enumerate().skip(from) {
        if code == BEL {
            return Scan::Complete(at + 1);
        }
        if code == ESC && at + 1 < data.len() && data[at + 1] == STRING_TERMINATOR {
            return Scan::Complete(at + 2);
        }
    }
    Scan::Pending
}

/// CSI: parameter and intermediate bytes, closed by one final byte.
fn scan_control_sequence(data: &[u16], start: usize, x10_mouse: bool) -> Scan {
    let body = start + 2;
    for (at, &code) in data.iter().enumerate().skip(body) {
        // `CSI M` with nothing in between is the X10 mouse prefix; SGR mouse (`CSI < ... M`) carries parameters and so
        // reaches its M further along.
        if x10_mouse && code == X10_MOUSE_FINAL && at == body && x10_payload_plausible(data, at) {
            return if at + 4 <= data.len() { Scan::Complete(at + 4) } else { Scan::Pending };
        }
        if is_control_final(code) {
            return Scan::Complete(at + 1);
        }
        if is_parameter(code) || is_intermediate(code) {
            continue;
        }
        return Scan::Literal(at);
    }
    Scan::Pending
}

/// ESC + intermediates (charset designators and friends) + one final byte.
fn scan_intermediate_escape(data: &[u16], from: usize) -> Scan {
    for (at, &code) in data.iter().enumerate().skip(from) {
        if is_intermediate(code) {
            continue;
        }
        if is_escape_final(code) {
            return Scan::Complete(at + 1);
        }
        return Scan::Literal(at);
    }
    Scan::Pending
}

/// Dispatch on the byte following ESC at `start`.
fn scan_escape(data: &[u16], start: usize, x10_mouse: bool) -> Scan {
    let head = start + 1;
    if head >= data.len() {
        return Scan::Pending;
    }
    let code = data[head];
    if code == OPEN_CSI {
        return scan_control_sequence(data, start, x10_mouse);
    }
    if code == OPEN_OSC || code == OPEN_DCS || code == OPEN_APC {
        return scan_string_family(data, head + 1);
    }
    if code == OPEN_SS3 {
        if head + 1 >= data.len() {
            return Scan::Pending;
        }
        return if is_control_final(data[head + 1]) { Scan::Complete(head + 2) } else { Scan::Literal(head + 1) };
    }
    if is_intermediate(code) {
        return scan_intermediate_escape(data, head + 1);
    }
    if is_escape_final(code) {
        return Scan::Complete(head + 1);
    }
    // ESC ESC: the first one stands alone so the second can open a fresh scan.
    if code == ESC {
        return Scan::Complete(head);
    }
    Scan::Literal(head)
}

fn tokenize(data: &[u16], flush: bool, x10_mouse: bool) -> (Vec<Token>, Vec<u16>) {
    let mut tokens = Vec::new();
    let mut text_start = 0;
    let mut cursor = 0;
    let mut pending_at = None;

    let emit_text = |tokens: &mut Vec<Token>, text_start: usize, to: usize| {
        if to > text_start {
            tokens.push(Token { kind: TokenKind::Text, value: data[text_start..to].to_vec() });
        }
    };

    while cursor < data.len() {
        if data[cursor] != ESC {
            cursor += 1;
            continue;
        }
        // Text accumulated so far closes here whether or not the sequence pans out; a rejected sequence simply opens the
        // next text run at this same ESC.
        emit_text(&mut tokens, text_start, cursor);
        match scan_escape(data, cursor, x10_mouse) {
            Scan::Complete(end) => {
                tokens.push(Token { kind: TokenKind::Sequence, value: data[cursor..end].to_vec() });
                cursor = end;
                text_start = cursor;
            }
            Scan::Pending => {
                pending_at = Some(cursor);
                break;
            }
            Scan::Literal(resume) => {
                text_start = cursor;
                cursor = resume;
            }
        }
    }

    let Some(pending_at) = pending_at else {
        emit_text(&mut tokens, text_start, data.len());
        return (tokens, Vec::new());
    };
    if !flush {
        return (tokens, data[pending_at..].to_vec());
    }
    tokens.push(Token { kind: TokenKind::Sequence, value: data[pending_at..].to_vec() });
    (tokens, Vec::new())
}

/// Streaming tokenizer. The only state carried between calls is the unfinished sequence text; a scan always restarts
/// from its leading ESC, so re-reading the carry reproduces the position the previous call stopped at.
///
/// `x10_mouse`: treat `CSI M` as an X10 mouse prefix and consume 3 payload bytes. Enable for stdin only: `ESC [ M` is CSI
/// DL in an output stream.
#[derive(Debug, Default)]
pub struct Tokenizer {
    x10_mouse: bool,
    carry: Vec<u16>,
}

impl Tokenizer {
    pub fn new(x10_mouse: bool) -> Self {
        Self { x10_mouse, carry: Vec::new() }
    }

    fn run(&mut self, input: &[u16], flush: bool) -> Vec<Token> {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(input);
        let (tokens, buffer) = tokenize(&data, flush, self.x10_mouse);
        self.carry = buffer;
        tokens
    }

    pub fn feed(&mut self, input: &[u16]) -> Vec<Token> {
        self.run(input, false)
    }

    pub fn flush(&mut self) -> Vec<Token> {
        self.run(&[], true)
    }

    pub fn reset(&mut self) {
        self.carry.clear();
    }

    pub fn buffer(&self) -> &[u16] {
        &self.carry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn texts(tokens: &[Token]) -> Vec<(TokenKind, String)> {
        tokens.iter().map(|t| (t.kind, String::from_utf16_lossy(&t.value))).collect()
    }

    #[test]
    fn splits_text_and_sequences() {
        let mut t = Tokenizer::new(true);
        let out = t.feed(&units("ab\x1b[Acd\x1bOP"));
        assert_eq!(
            texts(&out),
            vec![
                (TokenKind::Text, "ab".to_string()),
                (TokenKind::Sequence, "\x1b[A".to_string()),
                (TokenKind::Text, "cd".to_string()),
                (TokenKind::Sequence, "\x1bOP".to_string()),
            ]
        );
        assert!(t.buffer().is_empty());
    }

    #[test]
    fn carries_a_partial_sequence_across_feeds() {
        let mut t = Tokenizer::new(true);
        assert_eq!(t.feed(&units("x\x1b[1;")).len(), 1);
        assert_eq!(String::from_utf16_lossy(t.buffer()), "\x1b[1;");
        let out = t.feed(&units("5A"));
        assert_eq!(texts(&out), vec![(TokenKind::Sequence, "\x1b[1;5A".to_string())]);
    }

    #[test]
    fn flush_emits_the_tail_as_a_sequence() {
        let mut t = Tokenizer::new(true);
        assert!(t.feed(&units("\x1b")).is_empty());
        assert_eq!(texts(&t.flush()), vec![(TokenKind::Sequence, "\x1b".to_string())]);
        assert!(t.buffer().is_empty());
    }

    #[test]
    fn x10_mouse_consumes_three_payload_units() {
        let mut t = Tokenizer::new(true);
        let out = t.feed(&units("\x1b[M`!!x"));
        assert_eq!(texts(&out), vec![(TokenKind::Sequence, "\x1b[M`!!".to_string()), (TokenKind::Text, "x".to_string())]);
        // A control byte in a payload slot makes it CSI DL.
        let mut t = Tokenizer::new(true);
        let out = t.feed(&units("\x1b[M\x01"));
        assert_eq!(texts(&out)[0], (TokenKind::Sequence, "\x1b[M".to_string()));
        // Without the option `CSI M` is a plain sequence.
        let mut t = Tokenizer::new(false);
        let out = t.feed(&units("\x1b[M`!!"));
        assert_eq!(texts(&out)[0], (TokenKind::Sequence, "\x1b[M".to_string()));
    }

    #[test]
    fn rejected_sequence_degrades_to_text() {
        let mut t = Tokenizer::new(true);
        let out = t.feed(&units("\x1b\x01ab"));
        assert_eq!(texts(&out), vec![(TokenKind::Text, "\x1b\x01ab".to_string())]);
    }

    #[test]
    fn esc_esc_emits_the_first_alone() {
        let mut t = Tokenizer::new(true);
        let out = t.feed(&units("\x1b\x1b[A"));
        assert_eq!(texts(&out), vec![(TokenKind::Sequence, "\x1b".to_string()), (TokenKind::Sequence, "\x1b[A".to_string())]);
    }

    #[test]
    fn string_families_end_at_bel_or_st() {
        let mut t = Tokenizer::new(true);
        let out = t.feed(&units("\x1b]11;rgb:0/0/0\x07\x1bP>|x\x1b\\z"));
        assert_eq!(
            texts(&out),
            vec![
                (TokenKind::Sequence, "\x1b]11;rgb:0/0/0\x07".to_string()),
                (TokenKind::Sequence, "\x1bP>|x\x1b\\".to_string()),
                (TokenKind::Text, "z".to_string()),
            ]
        );
    }
}
