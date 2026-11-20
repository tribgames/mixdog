//! The raw UTF-16 entry points: an unpaired surrogate stays what it is for matching, collation and date reading.
use mixdog_js::{locale_compare, locale_compare_utf16, regex_is_match_utf16};
use mixdog_js::time::{date_parse_utf16, with_local_zone};
use std::cmp::Ordering;

#[test]
fn raw_error_text_is_sanitized_only_at_the_final_string_boundary() {
    let error = regex_is_match_utf16(&[0xd800, b'(' as u16], &[], "").unwrap_err();
    assert!(error.contains('\u{fffd}'));
    assert!(error.contains("Unterminated group"));
    // Matching cannot use that diagnostic's replacement-character spelling.
    assert_eq!(regex_is_match_utf16(&[0xd800], &[0xfffd], ""), Ok(false));
    assert_eq!(regex_is_match_utf16(&[0xd800], &[0xd800], ""), Ok(true));
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[test]
fn an_unpaired_surrogate_orders_by_its_own_weight_and_never_equals_a_replacement_character() {
    assert_eq!(locale_compare_utf16(&[0xd800], &[0xd801]), Ordering::Less);
    assert_eq!(locale_compare_utf16(&[0xd800], &[0xfffd]), Ordering::Less);
    assert_eq!(locale_compare_utf16(&[0xdc00], &[0xd800]), Ordering::Greater);
}

#[test]
fn collating_valid_text_as_utf16_gives_the_same_order_as_the_string_entry_point() {
    for (a, b) in [("a", "B"), ("résumé", "resume"), ("😀", "a"), ("10", "9"), ("", "x"), ("ä", "a")] {
        assert_eq!(locale_compare_utf16(&utf16(a), &utf16(b)), locale_compare(a, b), "{a:?} / {b:?}");
    }
}

#[test]
fn a_lone_surrogate_in_the_subject_matches_only_itself_and_dot() {
    assert_eq!(regex_is_match_utf16(&utf16("^.$"), &[0xd800], ""), Ok(true));
    assert_eq!(regex_is_match_utf16(&utf16("^.$"), &[0xd800], "u"), Ok(true));
    assert_eq!(regex_is_match_utf16(&utf16("a"), &[0xd800], ""), Ok(false));
    assert_eq!(regex_is_match_utf16(&[0xdc00], &[0xd800, 0xdc00], ""), Ok(true), "without u a pair is two units");
}

#[test]
fn a_surrogate_pair_is_one_character_only_in_unicode_mode() {
    let pair = utf16("😀");
    assert_eq!(regex_is_match_utf16(&utf16("^.$"), &pair, ""), Ok(false));
    assert_eq!(regex_is_match_utf16(&utf16("^.$"), &pair, "u"), Ok(true));
    assert_eq!(regex_is_match_utf16(&utf16("^..$"), &pair, ""), Ok(true));
}

#[test]
fn the_raw_date_reader_agrees_with_the_string_reader_on_valid_text_and_rejects_a_lone_surrogate() {
    with_local_zone("UTC".parse().unwrap(), || {
        assert_eq!(date_parse_utf16(&utf16("2000-01-01T00:00:00Z")), 946_684_800_000.0);
        let mut text = utf16("2000-01-01");
        text.push(0xd800);
        assert!(date_parse_utf16(&text).is_nan());
    });
}

// V8 (node 22): Date.parse("2000-01-01\0") and Date.parse("2000-01-01T00:00:00Z\0") are 946684800000 (a trailing NUL is
// ignored); Date.parse("\02000-01-01") is NaN (a leading NUL is not).
#[test]
fn a_trailing_nul_is_ignored_and_a_leading_nul_is_refused_as_v8_does() {
    with_local_zone("UTC".parse().unwrap(), || {
        assert_eq!(date_parse_utf16(&utf16("2000-01-01\u{0}")), 946_684_800_000.0);
        assert_eq!(date_parse_utf16(&utf16("2000-01-01T00:00:00Z\u{0}")), 946_684_800_000.0);
        assert!(date_parse_utf16(&utf16("\u{0}2000-01-01")).is_nan());
    });
}
