//! Conservative Unicode-aware token estimate for one text projection (a heuristic that prices
//! text, tuned to overcount; the provider's usage report is the exact baseline elsewhere).
//! Lengths and the dense/structured floors are in UTF-16 code units, the unit the estimate was
//! tuned in; the weighted sum walks code points.

fn code_point_weight(cp: u32) -> f64 {
    match cp {
        0..=0x7f => 0.25,
        0xac00..=0xd7a3 | 0x1100..=0x11ff | 0x3130..=0x318f | 0xa960..=0xa97f | 0xd7b0..=0xd7ff => 1.5,
        0x3040..=0x30ff | 0x31f0..=0x31ff => 1.2,
        0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x2fa1f => 1.2,
        0x2600..=0x27bf | 0x1f000..=0x1faff => 2.0,
        0x2190..=0x21ff | 0x2300..=0x23ff => 1.5,
        0x80..=0x3ff => 0.6,
        _ => 0.8,
    }
}

/// RegExp `\s` and `String#trim` whitespace.
fn is_whitespace(c: u16) -> bool {
    if c <= 0x20 {
        return c == 0x20 || (0x09..=0x0d).contains(&c);
    }
    if c < 0xa0 {
        return false;
    }
    matches!(c, 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn is_structural(c: u16) -> bool {
    c < 0x80 && matches!(c as u8, b'[' | b']' | b'{' | b'}' | b'"' | b':' | b',' | b'=' | b'<' | b'>' | b'|' | b'\\')
}

/// Dense runs (`[\x21-\x7e]{16,}`) priced by length, and encoded words (8+ alphanumerics with a
/// letter and a digit, not touching `_`).
fn dense_token_floor<U: Copy + Into<u16>>(s: &[U]) -> f64 {
    let unit = |index: usize| -> u16 { s[index].into() };
    let length = s.len();
    let mut floor = 0.0f64;
    let mut dense_run = 0usize;
    let mut word_start: Option<usize> = None;
    let (mut word_letter, mut word_digit) = (false, false);
    let (mut encoded_words, mut encoded_chars) = (0usize, 0usize);
    for index in 0..=length {
        let c: Option<u16> = s.get(index).copied().map(Into::into);
        if matches!(c, Some(0x21..=0x7e)) {
            dense_run += 1;
        } else if dense_run > 0 {
            if dense_run >= 16 {
                floor += dense_run as f64 * if dense_run >= 64 { 0.65 } else { 0.5 };
            }
            dense_run = 0;
        }
        let digit = matches!(c, Some(0x30..=0x39));
        let letter = matches!(c, Some(0x41..=0x5a | 0x61..=0x7a));
        if digit || letter {
            if word_start.is_none() {
                word_start = Some(index);
                word_letter = false;
                word_digit = false;
            }
            word_letter |= letter;
            word_digit |= digit;
        } else if let Some(start) = word_start.take()
            && index - start >= 8
            && word_letter
            && word_digit
            && c != Some(0x5f)
            && (start == 0 || unit(start - 1) != 0x5f)
        {
            encoded_words += 1;
            encoded_chars += index - start;
        }
    }
    if encoded_words >= 3 {
        floor = floor.max(encoded_chars as f64 * 0.5 + (length - encoded_chars) as f64 * 0.25);
    }
    floor
}

/// Text that is mostly structure (JSON-like lines, or a high share of brackets and quotes).
fn structured_token_floor<U: Copy + Into<u16>>(s: &[U]) -> f64 {
    let unit = |index: usize| -> u16 { s[index].into() };
    let length = s.len();
    let (mut lines, mut json_like, mut non_ws, mut structural) = (0usize, 0usize, 0usize, 0usize);
    let (mut first, mut last): (Option<usize>, usize) = (None, 0);
    let (mut pending_terminator, mut inner_terminator) = (false, false);
    for index in 0..=length {
        let c: u16 = s.get(index).copied().map_or(0x0a, Into::into);
        if c == 0x0a {
            if let Some(f) = first {
                lines += 1;
                let open = unit(f);
                let mut close = unit(last);
                if close == 0x2c && last > f + 1 {
                    close = unit(last - 1);
                }
                if matches!(open, 0x5b | 0x7b) && matches!(close, 0x5d | 0x7d) && !inner_terminator {
                    json_like += 1;
                }
            }
            first = None;
            pending_terminator = false;
            inner_terminator = false;
            continue;
        }
        if is_whitespace(c) {
            if first.is_some() && matches!(c, 0x0d | 0x2028 | 0x2029) {
                pending_terminator = true;
            }
            continue;
        }
        non_ws += 1;
        if is_structural(c) {
            structural += 1;
        }
        if first.is_none() {
            first = Some(index);
        } else if pending_terminator {
            inner_terminator = true;
        }
        last = index;
    }
    if lines < 3 || non_ws == 0 {
        return 0.0;
    }
    if json_like >= lines.div_ceil(2) || structural as f64 / non_ws as f64 >= 0.12 {
        non_ws as f64 * 0.5 + (length - non_ws) as f64 * 0.25
    } else {
        0.0
    }
}

/// The estimate: the max of the weighted code-point sum, the length/4 floor and the dense and
/// structured floors.
pub fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let weighted: f64 = text.chars().map(|c| code_point_weight(c as u32)).sum();
    // An ASCII text's UTF-16 code units are its bytes: the floors read it in place.
    let (length, dense) = if text.is_ascii() {
        let units = text.as_bytes();
        (units.len(), dense_token_floor(units).max(structured_token_floor(units)))
    } else {
        let units: Vec<u16> = text.encode_utf16().collect();
        (units.len(), dense_token_floor(&units).max(structured_token_floor(&units)))
    };
    weighted.max(length as f64 / 4.0).max(dense).ceil() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_costs_a_quarter_token_per_ascii_character_rounded_up() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens(&"word ".repeat(40)), 50);
    }

    #[test]
    fn other_scripts_and_symbols_cost_more_per_character() {
        assert_eq!(estimate_tokens("한글"), 3, "Hangul 1.5 each");
        assert_eq!(estimate_tokens("日本"), 3, "Han 1.2 each, 2.4 rounded up");
        assert_eq!(estimate_tokens("ひら"), 3, "Hiragana 1.2 each");
        assert_eq!(estimate_tokens("😀"), 2, "emoji 2.0");
        assert_eq!(estimate_tokens("éé"), 2, "Latin-1 and extended 0.6 each, 1.2 rounded up");
        assert_eq!(estimate_tokens("→"), 2, "arrows 1.5");
    }

    #[test]
    fn a_long_run_of_visible_characters_is_priced_by_its_length() {
        assert_eq!(estimate_tokens(&"!".repeat(15)), 4, "below sixteen the quarter rate holds");
        assert_eq!(estimate_tokens(&"!".repeat(16)), 8, "sixteen or more: half a token each");
        assert_eq!(estimate_tokens(&"!".repeat(64)), 42, "sixty-four or more: 0.65 each, rounded up");
    }

    #[test]
    fn three_encoded_words_price_the_whole_text_by_their_density() {
        // Three words of eight or more letters-and-digits: 24 encoded characters at 0.5 and two spaces at 0.25.
        assert_eq!(estimate_tokens("abc12345 def67890 ghi12345"), 13);
        assert_eq!(estimate_tokens("abc12345 def67890"), 5, "two are not enough");
    }

    #[test]
    fn structured_text_is_priced_at_half_a_token_per_non_blank_character() {
        let json = "[\n{\"a\":1},\n{\"b\":2}\n]";
        // 17 non-blank characters at 0.5 and 3 line breaks at 0.25.
        assert_eq!(estimate_tokens(json), 10);
        assert_eq!(estimate_tokens("a\nb"), 1, "fewer than three lines are never structured");
    }

    #[test]
    fn a_lone_surrogate_in_the_text_is_not_a_failure() {
        assert_eq!(estimate_tokens("\u{fffd} lone"), 3);
    }
}


