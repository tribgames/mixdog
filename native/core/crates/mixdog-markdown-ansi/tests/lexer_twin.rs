//! The lexer against the recording of the Node product's: `tests/goldens/lexer.json`, written by
//! `tests/recorders/record-lexer.mjs` from `marked.lexer(text)` (marked 14.1.4 after `configureMarked()` of
//! `src/tui/markdown/render-ansi.mjs`) over the files of `tests/corpus`. The recorder's `--check` run says whether the
//! recording is still the tree's lexer; these tests say whether this crate's lexer gives the same tokens.

use mixdog_markdown_ansi::lexer::{BLOCK, INLINE, lex};
use mixdog_markdown_ansi::render::has_markdown_syntax;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const GOLDEN: &str = include_str!("goldens/lexer.json");
const STRINGS: &str = include_str!("corpus/strings.json");
const EDGE: &str = include_str!("corpus/edge.json");
const DOCS: &str = include_str!("corpus/docs.json");
const PREFIX: &str = include_str!("corpus/prefix.json");

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|error| panic!("a recorded file does not parse: {error}"))
}

fn entries(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn text_of(entry: &Value) -> &str {
    entry["text"].as_str().unwrap_or("")
}

fn id_of(entry: &Value) -> &str {
    entry["id"].as_str().unwrap_or("")
}

/// The member's value in a recorded object, whatever the object is.
fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
    &value[key]
}

/// `JSON.stringify` of the value with its object keys sorted (the recorder's `canonical`).
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let members: Vec<String> = keys
                .iter()
                .map(|key| format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), canonical(&map[key.as_str()])))
                .collect();
            format!("{{{}}}", members.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// The first `hex` hex digits of the SHA-256 of `text`.
fn digest(text: &str, hex: usize) -> String {
    let bytes = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out.truncate(hex);
    out
}

/// What the recorder writes for a text: the tokens and the links table.
fn lexed_value(text: &str) -> Value {
    let lexed = lex(text);
    json!({ "tokens": lexed.tokens, "links": lexed.links })
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 90 {
        format!("{}...", text.chars().take(90).collect::<String>())
    } else {
        text
    }
}

/// The path of the first member in which the two differ.
fn first_difference(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, want_value) in want {
                match got.get(key) {
                    Some(got_value) => {
                        if let Some(found) = first_difference(want_value, got_value, &format!("{path}.{key}")) {
                            return Some(found);
                        }
                    }
                    None => return Some(format!("{path}.{key} is missing")),
                }
            }
            got.keys().find(|key| !want.contains_key(key.as_str())).map(|key| format!("{path}.{key} is not in the recording"))
        }
        (Value::Array(want), Value::Array(got)) => {
            for (index, (want_value, got_value)) in want.iter().zip(got).enumerate() {
                if let Some(found) = first_difference(want_value, got_value, &format!("{path}[{index}]")) {
                    return Some(found);
                }
            }
            (want.len() != got.len()).then(|| format!("{path} has {} items, the recording {}", got.len(), want.len()))
        }
        _ => (expected != actual).then(|| format!("{path}: recorded {}, lexed {}", short(expected), short(actual))),
    }
}

#[test]
fn the_rule_table_is_the_recorded_one() {
    let golden = parse(GOLDEN);
    let mut wrong = Vec::new();
    for (side, table) in [("block", BLOCK), ("inline", INLINE)] {
        for (name, source, flags) in table {
            let recorded = &golden["rules"][side][*name];
            if recorded["source"].as_str() != Some(*source) || recorded["flags"].as_str() != Some(*flags) {
                wrong.push(format!("{side}.{name}"));
            }
        }
    }
    assert!(wrong.is_empty(), "rules that differ from marked's: {wrong:?}");
    assert_eq!(golden["marked"].as_str(), Some("14.1.4"));
}

/// Every text of `corpus` against the whole token list the recording kept for it.
fn check_token_lists(corpus: &str, recorded: &Value) {
    let corpus = parse(corpus);
    let recorded = entries(recorded);
    assert_eq!(entries(&corpus).len(), recorded.len(), "the recording and the corpus have different entries");
    let mut wrong = Vec::new();
    for (entry, want) in entries(&corpus).iter().zip(recorded) {
        assert_eq!(id_of(entry), id_of(want));
        let text = text_of(entry);
        if want["syntax"].as_bool() != Some(has_markdown_syntax(text)) {
            wrong.push(format!("{}: the syntax probe differs", id_of(entry)));
        }
        let actual = lexed_value(text);
        if let Some(found) = first_difference(member(want, "result"), &actual, "") {
            wrong.push(format!("{}: {found}", id_of(entry)));
        } else if digest(&canonical(&actual), 16) != want["digest"].as_str().unwrap_or_default() {
            wrong.push(format!("{}: the digest differs", id_of(entry)));
        }
    }
    assert!(wrong.is_empty(), "{} of {} texts differ, first: {:?}", wrong.len(), recorded.len(), wrong.iter().take(8).collect::<Vec<_>>());
}

#[test]
fn the_strings_of_the_markdown_tests_lex_as_marked_does() {
    check_token_lists(STRINGS, member(&parse(GOLDEN), "strings"));
}

#[test]
fn the_hand_written_edge_cases_lex_as_marked_does() {
    check_token_lists(EDGE, member(&parse(GOLDEN), "edge"));
}

#[test]
fn the_documents_lex_as_marked_does() {
    let golden = parse(GOLDEN);
    let docs = parse(DOCS);
    let recorded = entries(member(&golden, "docs"));
    assert_eq!(entries(&docs).len(), recorded.len());
    let mut wrong = Vec::new();
    for (entry, want) in entries(&docs).iter().zip(recorded) {
        assert_eq!(id_of(entry), id_of(want));
        let text = text_of(entry);
        if want["syntax"].as_bool() != Some(has_markdown_syntax(text)) {
            wrong.push(format!("{}: the syntax probe differs", id_of(entry)));
        }
        if digest(&canonical(&lexed_value(text)), 16) != want["digest"].as_str().unwrap_or_default() {
            wrong.push(format!("{}: the tokens differ", id_of(entry)));
        }
    }
    assert!(wrong.is_empty(), "documents that differ: {wrong:?}");
}

/// The byte offset of the end of the first `unit` UTF-16 units of `text`, `None` inside a surrogate pair.
fn byte_offsets_by_unit(text: &str) -> Vec<Option<usize>> {
    let mut at = vec![Some(0)];
    for (start, c) in text.char_indices() {
        if c.len_utf16() == 2 {
            at.push(None);
        }
        at.push(Some(start + c.len_utf8()));
    }
    at
}

/// The prefix cases are cut into this many slices; a case belongs to the slice its unit number is congruent to, so every
/// case runs in exactly one slice and the slices cost about the same.
const PREFIX_SLICES: usize = 8;

/// How many of the units `1..=limit` fall in `slice`.
fn slice_units(limit: usize, slice: usize) -> usize {
    (1..=limit).filter(|unit| unit % PREFIX_SLICES == slice).count()
}

fn check_prefix_slice(slice: usize) {
    let golden = parse(GOLDEN);
    let docs = parse(DOCS);
    let prefix = parse(PREFIX);
    let recorded = entries(member(&golden, "prefixes"));
    assert_eq!(entries(&prefix["docs"]).len(), recorded.len());
    let mut wrong = Vec::new();
    let mut checked = 0;
    for want in recorded {
        let id = id_of(want);
        let text = entries(&docs).iter().find(|doc| id_of(doc) == id).map_or("", text_of);
        let offsets = byte_offsets_by_unit(text);
        let limit = usize::try_from(want["limit"].as_u64().unwrap_or(0)).unwrap_or(0);
        let digests = want["digests"].as_str().unwrap_or("");
        assert_eq!(digests.len(), limit * 8, "{id}");
        for unit in (1..=limit).filter(|unit| unit % PREFIX_SLICES == slice) {
            checked += 1;
            let expected = &digests[(unit - 1) * 8..unit * 8];
            // A cut inside a surrogate pair is not a Rust string: the recording has no digest for it either.
            let actual = match offsets.get(unit).copied().flatten() {
                Some(end) => digest(&canonical(&lexed_value(&text[..end])), 8),
                None => "--------".to_owned(),
            };
            if expected != actual {
                wrong.push(format!("{id}: prefix of {unit} units"));
                break;
            }
        }
    }
    let total: usize = recorded.iter().map(|want| slice_units(usize::try_from(want["limit"].as_u64().unwrap_or(0)).unwrap_or(0), slice)).sum();
    println!("prefix slice {slice}: {checked} cases");
    assert!(!wrong.is_empty() || checked == total, "every case of the slice ran");
    assert!(wrong.is_empty(), "prefixes that differ: {wrong:?}");
}

#[test]
fn the_prefix_slices_cover_every_unit_once() {
    let golden = parse(GOLDEN);
    let mut all = 0;
    for want in entries(member(&golden, "prefixes")) {
        let limit = usize::try_from(want["limit"].as_u64().unwrap_or(0)).unwrap_or(0);
        let sliced: usize = (0..PREFIX_SLICES).map(|slice| slice_units(limit, slice)).sum();
        assert_eq!(sliced, limit, "{}", id_of(want));
        all += limit;
    }
    println!("prefix cases in all slices: {all}");
}

macro_rules! prefix_slices {
    ($($name:ident = $slice:expr),*) => {
        $(
            #[test]
            fn $name() {
                check_prefix_slice($slice);
            }
        )*
    };
}

prefix_slices!(
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_0 = 0,
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_1 = 1,
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_2 = 2,
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_3 = 3,
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_4 = 4,
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_5 = 5,
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_6 = 6,
    every_prefix_of_the_long_documents_lexes_as_marked_does_slice_7 = 7
);
