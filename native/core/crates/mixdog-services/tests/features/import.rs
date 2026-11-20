//! Converting another tool's transcript into turns: the verdict, the limits and the warnings.

use mixdog_services::import::convert::Converter;
use mixdog_services::import::{Conversion, Limits, Source};

const CODEX_META: &str = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"c1\",\"cwd\":\"/w\"}}\n";
const CODEX_USER: &str =
    "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Fix the build\"}]}}\n";
const CODEX_REPLY: &str =
    "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done\"}]}}\n";

fn convert_with(source: Source, text: &str, limits: Limits) -> Conversion {
    let mut converter = Converter::new(source, limits);
    for line in text.split('\n') {
        if !converter.push_line(line, false) {
            break;
        }
    }
    converter.result()
}

fn convert(source: Source, text: &str) -> Conversion {
    convert_with(source, text, Limits::default())
}

#[test]
fn a_transcript_with_nothing_in_it_is_empty_and_one_of_only_junk_is_malformed() {
    for source in [Source::Codex, Source::Claude, Source::Cowork] {
        assert_eq!(convert(source, "").error_code.as_deref(), Some("empty"), "{source:?}");
        assert_eq!(convert(source, "\n \n").error_code.as_deref(), Some("empty"));
        let junk = convert(source, "not json\n[1,2]\n");
        assert_eq!(junk.error_code.as_deref(), Some("malformed"), "{source:?}");
    }
}

#[test]
fn records_the_importer_does_not_know_are_unsupported() {
    let c = convert(Source::Codex, "{\"hello\":\"world\"}\n");
    assert_eq!(c.error_code.as_deref(), Some("unsupported"));
    assert!(c.turns.is_empty());
}

#[test]
fn a_session_that_only_has_metadata_has_no_turns_to_import() {
    let c = convert(Source::Codex, CODEX_META);
    assert_eq!(c.error_code.as_deref(), Some("empty"));
    assert_eq!((c.foreign_session_id.as_deref(), c.cwd.as_deref()), (Some("c1"), Some("/w")));
}

#[test]
fn a_bad_line_among_good_ones_is_skipped_and_reported_once() {
    let text = format!("{CODEX_META}oops\nalso oops\n{CODEX_USER}{CODEX_REPLY}");
    let c = convert(Source::Codex, &text);
    assert_eq!((c.error_code, c.message_count, c.warnings), (None, 2, vec!["malformed".to_owned()]));
}

#[test]
fn a_transcript_over_a_limit_is_too_large_and_returns_no_turns() {
    let text = format!("{CODEX_META}{CODEX_USER}{CODEX_REPLY}");
    for limits in [Limits { max_transcript_chars: 5, ..Limits::default() }, Limits { max_retained_entries: 1, ..Limits::default() }] {
        let c = convert_with(Source::Codex, &text, limits);
        assert_eq!(c.error_code.as_deref(), Some("tooLarge"));
        assert!((c.message_count, c.turns.len()) == (0, 0));
    }
}

#[test]
fn a_leading_byte_order_mark_and_windows_line_ends_are_ignored() {
    let text = format!("\u{feff}{}", format!("{CODEX_META}{CODEX_USER}{CODEX_REPLY}").replace('\n', "\r\n"));
    let c = convert(Source::Codex, &text);
    assert_eq!((c.error_code, c.message_count, c.warnings.len()), (None, 2, 0));
}

#[test]
fn a_source_is_known_by_its_lowercase_name() {
    for (name, source) in [("codex", Source::Codex), ("claude", Source::Claude), ("cowork", Source::Cowork)] {
        assert_eq!(Source::parse(name), Some(source));
        assert_eq!(source.as_str(), name);
    }
    assert_eq!(Source::parse("Codex"), None);
    assert!(Source::Claude.is_claude_format() && Source::Cowork.is_claude_format() && !Source::Codex.is_claude_format());
}
