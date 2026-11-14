//! Direct Node evidence. No surrogate, collation-order or NaN normalization.
use icu_collator::CollatorBorrowed;
use icu_collator::options::CollatorOptions;
use icu_locale_core::Locale;
use mixdog_js::{locale_compare, locale_compare_utf16, regex_is_match_utf16};
use mixdog_js::time::{date_parse_utf16, with_local_zone};
use serde_json::{json, Value};
use std::cmp::Ordering;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/js-utf16-bridges/golden.json")).unwrap()
}
fn units(value: &Value) -> Vec<u16> {
    value.as_array().unwrap().iter().map(|v| u16::try_from(v.as_u64().unwrap()).unwrap()).collect()
}
fn sign(order: Ordering) -> i64 { match order { Ordering::Less => -1, Ordering::Equal => 0, Ordering::Greater => 1 } }
fn report(failures: Vec<String>) {
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn raw_pattern_and_subject_match_node_in_unit_and_unicode_modes() {
    let golden = golden();
    let rows = golden["regex"].as_array().unwrap();
    assert!(rows.len() > 4000);
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let actual = regex_is_match_utf16(&units(&row["pattern"]), &units(&row["text"]), row["flags"].as_str().unwrap());
        let expected = if let Some(value) = row["matched"].as_bool() { Ok(value) } else { Err(row["error"].as_str().unwrap().to_owned()) };
        if actual != expected { failures.push(format!("{i}: {row}: got {actual:?}, expected {expected:?}")); }
    }
    report(failures);
}

#[test]
fn raw_date_reader_matches_node_and_datevalue_projection() {
    let golden = golden();
    let rows = golden["dates"].as_array().unwrap();
    assert!(rows.len() > 150);
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let actual = with_local_zone(row["zone"].as_str().unwrap().parse().unwrap(), || date_parse_utf16(&units(&row["text"])));
        let bits = format!("{:016x}", actual.to_bits());
        if bits != row["bits"].as_str().unwrap() { failures.push(format!("Date.parse {i}: {row}: got {bits}")); }
        let projected = if actual.is_nan() { json!({"error":"#VALUE!"}) } else { json!({"dateBits":bits}) };
        if projected != row["dateValue"] { failures.push(format!("DATEVALUE boundary {i}: expected {}, got {projected}",row["dateValue"])); }
    }
    report(failures);
}

#[test]
fn raw_collation_matches_node_across_boundaries_contractions_and_french_secondary() {
    let golden = golden();
    let mut failures = Vec::new();
    let mut count = 0;
    for group in golden["collations"].as_array().unwrap() {
        let name = group["locale"].as_str().unwrap();
        let named = if name.is_empty() { None } else {
            let locale: Locale = name.parse().unwrap();
            Some(CollatorBorrowed::try_new((&locale).into(), CollatorOptions::default()).unwrap())
        };
        for (i, row) in group["pairs"].as_array().unwrap().iter().enumerate() {
            let (left, right) = (units(&row[0]), units(&row[1]));
            let actual = named.as_ref().map_or_else(|| locale_compare_utf16(&left, &right), |collator|collator.compare_raw_utf16(&left, &right));
            if sign(actual) != row[2].as_i64().unwrap() { failures.push(format!("locale {name:?} pair {i}: {row}: got {actual:?}")); }
            count += 1;
        }
    }
    assert!(count > 60_000);
    report(failures);
}

#[test]
fn valid_string_comparison_is_unchanged_and_no_surrogate_equals_a_replacement() {
    let existing: Value = serde_json::from_str(mixdog_testkit::fixture!("testdata/locale_compare.json")).unwrap();
    for pair in existing["pairs"].as_array().unwrap() {
        let (left, right) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        let a: Vec<_> = left.encode_utf16().collect(); let b: Vec<_> = right.encode_utf16().collect();
        assert_eq!(locale_compare_utf16(&a, &b), locale_compare(left, right), "{left:?} / {right:?}");
        assert_eq!(sign(locale_compare(left, right)), pair[2].as_i64().unwrap());
    }
    assert_eq!(locale_compare_utf16(&[0xd800], &[0xd801]), Ordering::Less);
    assert_eq!(locale_compare_utf16(&[0xd800], &[0xfffd]), Ordering::Less);
    assert_eq!(locale_compare_utf16(&[0xdc00], &[0xd800]), Ordering::Greater);
}

#[test]
fn raw_error_text_is_sanitized_only_at_the_final_string_boundary() {
    let error = regex_is_match_utf16(&[0xd800, b'(' as u16], &[], "").unwrap_err();
    assert!(error.contains('\u{fffd}'));
    assert!(error.contains("Unterminated group"));
    // Matching cannot use that diagnostic's replacement-character spelling.
    assert_eq!(regex_is_match_utf16(&[0xd800], &[0xfffd], ""), Ok(false));
    assert_eq!(regex_is_match_utf16(&[0xd800], &[0xd800], ""), Ok(true));
}
