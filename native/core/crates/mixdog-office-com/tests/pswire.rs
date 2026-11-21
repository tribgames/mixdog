//! The PowerShell value semantics the Office COM hosts' results depend on (`mixdog_office_com::ps`): each test states the
//! text or the value Windows PowerShell 5.1 gives for its input. No COM object and no Office is involved.

use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::collate;
use mixdog_office_com::ps::collate::SortOptions;
use mixdog_office_com::ps::convert;
use mixdog_office_com::ps::datetime;
use mixdog_office_com::ps::fingerprint;
use mixdog_office_com::ps::json;
use mixdog_office_com::ps::text;

#[test]
fn numbers_round_half_to_even_when_cast_to_an_integer_and_text_parses_or_names_the_failure() {
    assert_eq!(convert::to_int(&Value::Double(2.5)), Ok(2));
    assert_eq!(convert::to_int(&Value::Double(3.5)), Ok(4));
    assert_eq!(convert::to_int(&Value::Double(-2.5)), Ok(-2));
    assert_eq!(convert::to_int(&Value::string("12")), Ok(12));
    assert_eq!(
        convert::to_int(&Value::string("abc")),
        Err("Cannot convert value \"abc\" to type \"System.Int32\". Error: \"Input string was not in a correct format.\"".to_owned())
    );
    assert!(convert::to_int(&Value::Double(3_000_000_000.0)).is_err(), "out of the Int32 range is an error");
}

#[test]
fn values_print_the_way_powershell_writes_them() {
    assert_eq!(convert::to_ps_string(&Value::Bool(true)), "True");
    assert_eq!(convert::to_ps_string(&Value::Bool(false)), "False");
    assert_eq!(convert::to_ps_string(&Value::Double(3.0)), "3");
    assert_eq!(convert::to_ps_string(&Value::Double(0.1 + 0.2)), "0.3", "a double has 15 significant digits");
    assert_eq!(convert::to_ps_string(&Value::Double(1e20)), "1E+20");
    assert_eq!(convert::to_ps_string(&Value::Int(-7)), "-7");
    assert_eq!(convert::to_ps_string(&Value::Null), "");
}

#[test]
fn a_boolean_cast_follows_truthiness_not_the_text() {
    assert!(!convert::to_bool(&Value::string("")));
    assert!(convert::to_bool(&Value::string("false")), "a non-empty string is true");
    assert!(!convert::to_bool(&Value::Int(0)));
    assert!(convert::to_bool(&Value::Int(2)));
    assert!(!convert::to_bool(&Value::Null));
}

#[test]
fn comparisons_in_text_ignore_case_unless_the_case_sensitive_form_is_used() {
    assert_eq!(text::is_match("Hello", "^h", false), Ok(true));
    assert_eq!(text::is_match("Hello", "^h", true), Ok(false));
    assert_eq!(text::replace("Hello hello", "h", "J", false).as_deref(), Ok("Jello Jello"));
    assert_eq!(text::replace("Hello hello", "h", "J", true).as_deref(), Ok("Hello Jello"));
    assert!(text::like("Report.DOCX", "*.docx"));
    assert!(!text::like("Report.pdf", "*.docx"));
    assert_eq!(text::regex_escape("a.b*c"), "a\\.b\\*c");
    assert_eq!(text::to_lower_invariant("ABC"), "abc");
    assert!(text::is_match("x", "(", false).is_err(), "a bad pattern is the host's error, not a panic");
}

#[test]
fn a_replacement_reads_groups_names_and_the_dollar_symbols_and_keeps_an_unknown_dollar_literal() {
    assert_eq!(text::replace("John Smith", "(\\w+) (\\w+)", "$2, $1", false).as_deref(), Ok("Smith, John"));
    assert_eq!(text::replace("John Smith", "(?<first>\\w+) (\\w+)", "${first}-${2}", false).as_deref(), Ok("John-Smith"));
    assert_eq!(text::replace("a", "a", "$$", false).as_deref(), Ok("$"));
    assert_eq!(text::replace("xay", "a", "<$&|$`|$'>", false).as_deref(), Ok("x<a|x|y>y"));
    assert_eq!(text::replace("ab", "(a)(b)", "$+", false).as_deref(), Ok("b"));
    assert_eq!(text::replace("ab", "b", "$_", false).as_deref(), Ok("aab"));
    assert_eq!(text::replace("a", "a", "$z ${nope} $9", false).as_deref(), Ok("$z ${nope} $9"));
}

#[test]
fn a_like_pattern_reads_character_classes_and_the_backtick_escape() {
    assert!(text::like("b", "[a-c]"));
    assert!(!text::like("d", "[a-c]"));
    assert!(text::like("a*", "a`*"));
    assert!(!text::like("ab", "a`*"));
    assert!(text::like("a[b", "a[b"), "an unclosed class is a literal bracket");
}

#[test]
fn sorting_orders_numbers_by_value_and_text_without_regard_to_case_and_can_keep_one_of_each() {
    let numbers = [Value::Int(10), Value::Int(9), Value::Int(100)];
    let ascending = collate::sort_values(&numbers, SortOptions::default());
    assert_eq!(ascending, vec![Value::Int(9), Value::Int(10), Value::Int(100)]);
    let descending = collate::sort_values(&numbers, SortOptions { descending: true, unique: false });
    assert_eq!(descending, vec![Value::Int(100), Value::Int(10), Value::Int(9)]);
    let names = [Value::string("b"), Value::string("B"), Value::string("a")];
    let unique = collate::sort_values(&names, SortOptions { descending: false, unique: true });
    assert_eq!(unique.len(), 2, "b and B are one name when case is ignored");
    assert_eq!(unique[0], Value::string("a"));
}

#[test]
fn grouping_counts_by_text_and_lists_the_largest_group_first() {
    let values = [Value::string("x"), Value::string("y"), Value::string("y"), Value::string("y"), Value::string("x"), Value::string("z")];
    let groups: Vec<(String, usize)> = collate::groups_by_count_descending(&values).into_iter().map(|group| (group.name, group.count)).collect();
    assert_eq!(groups, vec![("y".to_owned(), 3), ("x".to_owned(), 2), ("z".to_owned(), 1)]);
}

#[test]
fn json_is_compact_keeps_key_order_and_escapes_what_convertto_json_escapes() {
    let mut ordered = mixdog_office_com::ps::Object::new(mixdog_office_com::ps::ObjectKind::Ordered);
    ordered.set("b", Value::Int(1));
    ordered.set("a", Value::string("x\"y\n"));
    ordered.set("list", Value::Array(vec![Value::Int(1), Value::Bool(true), Value::Null]));
    assert_eq!(json::to_json(&Value::Object(ordered), 20), "{\"b\":1,\"a\":\"x\\\"y\\n\",\"list\":[1,true,null]}");
    assert_eq!(json::to_json(&Value::Null, 20), "", "a null writes nothing");
    // Windows PowerShell 5.1 writes <, >, & and ' as \u escapes.
    assert_eq!(json::to_json(&Value::string("<a href='x'>&</a>"), 20), "\"\\u003ca href=\\u0027x\\u0027\\u003e\\u0026\\u003c/a\\u003e\"");
}

#[test]
fn a_one_element_array_through_the_pipeline_is_that_element() {
    assert_eq!(json::pipeline_text(&Value::Array(vec![Value::Int(5)]), 20).as_deref(), Some("5"));
    assert_eq!(json::pipeline_text(&Value::Array(vec![Value::Int(5), Value::Int(6)]), 20).as_deref(), Some("[5,6]"));
}

#[test]
fn text_fingerprints_are_the_lowercase_hex_sha256_of_the_text() {
    assert_eq!(fingerprint::text_sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(fingerprint::text_sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

#[test]
fn an_ole_date_is_written_as_a_round_trip_local_time_and_a_date_in_utc_gets_a_z() {
    assert_eq!(datetime::oa_date_to_local_text(25569.0).expect("date"), "1970-01-01T00:00:00.0000000");
    assert_eq!(datetime::oa_date_to_local_text(25569.5).expect("date"), "1970-01-01T12:00:00.0000000");
    let ticks = datetime::ticks_from_civil(&datetime::Civil { year: 2026, month: 9, day: 12, hour: 3, minute: 4, second: 5, subsecond_ticks: 0 });
    assert_eq!(datetime::round_trip_text(ticks, true), "2026-09-12T03:04:05.0000000Z");
    assert_eq!(datetime::round_trip_text(ticks, false), "2026-09-12T03:04:05.0000000");
}
