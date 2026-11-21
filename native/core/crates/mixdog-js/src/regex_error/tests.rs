use super::*;
#[test]
fn deeply_nested_classes_report_a_stack_overflow_instead_of_crashing() {
    let deep = format!("{}{}", "[".repeat(50_000), "]".repeat(50_000));
    assert_eq!(js_regex_error(&deep, "v").map(|m| m.rsplit(": ").next().unwrap_or("").to_owned()).as_deref(), Some("Maximum call stack size exceeded"));
    assert_eq!(js_regex_error(&format!("{}{}", "[".repeat(100), "]".repeat(100)), "v"), None);
}

fn message(pattern: &str, flags: &str) -> Option<String> {
    js_regex_error(pattern, flags)
}

#[test]
fn a_syntax_error_reads_as_the_engine_words_it() {
    for (pattern, reason) in [
        ("(", "Unterminated group"),
        ("[", "Unterminated character class"),
        (")", "Unmatched ')'"),
        ("*", "Nothing to repeat"),
        ("a**", "Nothing to repeat"),
        ("a{2,1}", "numbers out of order in {} quantifier"),
        ("\\", "\\ at end of pattern"),
        ("[b-a]", "Range out of order in character class"),
        ("(?<a>.)(?<a>.)", "Duplicate capture group name"),
    ] {
        assert_eq!(message(pattern, "").as_deref(), Some(format!("Invalid regular expression: /{pattern}/: {reason}").as_str()), "{pattern}");
    }
}

#[test]
fn the_flags_are_shown_after_the_pattern_and_a_bad_flag_set_is_its_own_error() {
    assert_eq!(message("(", "gi").as_deref(), Some("Invalid regular expression: /(/gi: Unterminated group"));
    assert_eq!(message("a", "gg").as_deref(), Some("Invalid flags supplied to RegExp constructor 'gg'"));
    assert_eq!(message("a", "uv").as_deref(), Some("Invalid flags supplied to RegExp constructor 'uv'"));
    assert_eq!(message("a", "x").as_deref(), Some("Invalid flags supplied to RegExp constructor 'x'"));
}

#[test]
fn unicode_mode_rejects_what_legacy_mode_tolerates() {
    for pattern in ["{", "}", "\\-", "\\k<a>", "[\\d-a]", "\\p{Foo}", "\\u{110000}", "a{1"] {
        assert_eq!(message(pattern, ""), None, "{pattern} without u");
        assert!(message(pattern, "u").is_some(), "{pattern} with u");
    }
}

#[test]
fn valid_patterns_have_no_error() {
    for pattern in ["a+b?", "(?:x)|y", "(?<n>.)\\k<n>", "(?<=a)b", "[^\\]]", "\\p{L}", "a{2,3}", "^$", "\\1(a)"] {
        assert_eq!(message(pattern, ""), None, "{pattern}");
    }
    assert_eq!(message("[\\p{L}--[a-z]]", "v"), None);
    assert_eq!(message("\\p{L}", "u"), None);
}
