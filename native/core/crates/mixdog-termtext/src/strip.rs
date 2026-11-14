//! `strip-ansi` 7.2.0: removes what the `ansi-regex` 6 pattern matches.
//!
//! The pattern is `osc|csi`, global, leftmost, first alternative first:
//! - `osc`: ESC `]`, any text, up to the first string terminator (BEL, ESC `\`, or U+009C). With no terminator the
//!   alternative fails and the CSI alternative is tried at the same place.
//! - `csi`: ESC or U+009B, then `[ [ ] ( ) # ; ? ]*`, then optionally `\d{1,4}([;:]\d{0,4})*`, then one final byte
//!   from `[\dA-PR-TZcf-nq-uy=><~]`.
//!
//! The text is scanned as UTF-8 bytes: every byte the pattern names is ASCII except U+009B and U+009C, which are
//! the two-byte sequences C2 9B and C2 9C.

use std::borrow::Cow;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const C1_LEAD: u8 = 0xc2;
const CSI_TAIL: u8 = 0x9b;
const ST_TAIL: u8 = 0x9c;

/// `stripAnsi(string)`: the text without its escape sequences. A text without ESC or U+009B is returned as it is.
pub fn strip_ansi(input: &str) -> Cow<'_, str> {
    if !input.contains('\u{1b}') && !input.contains('\u{9b}') {
        return Cow::Borrowed(input);
    }
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        match match_at(bytes, at) {
            Some(end) => {
                out.push_str(&input[copied..at]);
                copied = end;
                at = end;
            }
            None => at += 1,
        }
    }
    out.push_str(&input[copied..]);
    Cow::Owned(out)
}

/// The end of the escape sequence that starts at `at`, if one does.
fn match_at(bytes: &[u8], at: usize) -> Option<usize> {
    let introducer = if bytes[at] == ESC {
        1
    } else if bytes[at] == C1_LEAD && bytes.get(at + 1) == Some(&CSI_TAIL) {
        2
    } else {
        return None;
    };
    if introducer == 1
        && bytes.get(at + 1) == Some(&b']')
        && let Some(end) = osc_end(bytes, at + 2)
    {
        return Some(end);
    }
    csi_end(bytes, at + introducer)
}

/// The end of the first string terminator at or after `from`.
fn osc_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while at < bytes.len() {
        match bytes[at] {
            BEL => return Some(at + 1),
            ESC if bytes.get(at + 1) == Some(&b'\\') => return Some(at + 2),
            C1_LEAD if bytes.get(at + 1) == Some(&ST_TAIL) => return Some(at + 2),
            _ => at += 1,
        }
    }
    None
}

fn is_prefix(byte: u8) -> bool {
    matches!(byte, b'[' | b']' | b'(' | b')' | b'#' | b';' | b'?')
}

fn is_final(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'A'..=b'P' | b'R'..=b'T' | b'Z' | b'c' | b'f'..=b'n' | b'q'..=b'u' | b'y' | b'=' | b'>' | b'<' | b'~')
}

/// Up to four digits from `at`.
fn digits(bytes: &[u8], at: usize) -> usize {
    bytes[at.min(bytes.len())..].iter().take(4).take_while(|b| b.is_ascii_digit()).count()
}

/// The end of a CSI sequence whose introducer ends at `from`.
fn csi_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while bytes.get(at).is_some_and(|&b| is_prefix(b)) {
        at += 1;
    }
    if !bytes.get(at).is_some_and(u8::is_ascii_digit) {
        return bytes.get(at).filter(|&&b| is_final(b)).map(|_| at + 1);
    }
    // The parameter group takes as much as it can: `\d{1,4}` then `[;:]\d{0,4}` repeated. When the byte after it is not
    // a final byte, the pattern gives back digits one by one from the end, and the first one given back is a final
    // byte (digits are): the match then ends after the last digit the group took.
    at += digits(bytes, at);
    while matches!(bytes.get(at), Some(b';' | b':')) {
        at += 1;
        at += digits(bytes, at);
    }
    if bytes.get(at).is_some_and(|&b| is_final(b)) {
        return Some(at + 1);
    }
    bytes[from..at].iter().rposition(u8::is_ascii_digit).map(|last| from + last + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_returned_as_it_is() {
        assert!(matches!(strip_ansi("plain 日本語"), Cow::Borrowed(_)));
    }

    #[test]
    fn sgr_and_cursor_sequences_are_removed() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("\x1b[1;38;2;255;0;0mx\x1b[m"), "x");
        assert_eq!(strip_ansi("a\x1b[?25hb\x1b(Bc\x1b#8d"), "abcd");
        assert_eq!(strip_ansi("\u{9b}31mx"), "x");
    }

    #[test]
    fn osc_ends_at_the_first_terminator() {
        assert_eq!(strip_ansi("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link");
        assert_eq!(strip_ansi("\x1b]8;;u\u{9c}link"), "link");
        assert_eq!(strip_ansi("\x1b]0;title\x07rest"), "rest");
    }

    #[test]
    fn an_unterminated_osc_falls_back_to_the_csi_alternative() {
        // ESC, ] as a prefix byte, the parameter 0;, then t as the final byte.
        assert_eq!(strip_ansi("\x1b]0;title"), "itle");
        assert_eq!(strip_ansi("\x1b]x"), "\x1b]x");
    }

    #[test]
    fn backtracking_gives_a_digit_back_as_the_final_byte() {
        assert_eq!(strip_ansi("\x1b[1;"), ";");
        assert_eq!(strip_ansi("\x1b[1;2;3"), "");
        assert_eq!(strip_ansi("\x1b[12345m"), "m");
        assert_eq!(strip_ansi("\x1b[99999m"), "m");
        assert_eq!(strip_ansi("\x1b[1;2H"), "");
        assert_eq!(strip_ansi("\x1b[1;\u{1f642}"), ";\u{1f642}");
    }

    #[test]
    fn malformed_introducers_stay() {
        assert_eq!(strip_ansi("a\x1bb"), "a\x1bb");
        assert_eq!(strip_ansi("\x1b"), "\x1b");
        assert_eq!(strip_ansi("\x1b["), "\x1b[");
        assert_eq!(strip_ansi("\x1b[\x1b[1mx"), "\x1b[x");
    }
}
