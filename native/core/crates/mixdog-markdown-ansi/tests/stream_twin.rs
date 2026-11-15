//! The streaming code and the REPL renderer against the recording of the Node product's:
//! `tests/goldens/stream.json`, written by `tests/recorders/record-stream.mjs` from `streaming-markdown.mjs`,
//! `stream-fence.mjs`, `streaming-markdown-heal.mjs`, `stream-finalize.mjs`, `render-ansi.mjs` (the tokens of the streaming
//! tail) and `src/ui/markdown.mjs`. Thirty documents are fed to the streaming functions one UTF-16 unit at a time, under a
//! stream key per document, in the order the recorder calls them (the per-stream caches are part of what is compared);
//! the REPL renderer runs over those documents and the lexer corpus at the widths 40, 80 and 120 with colour on and off.
//! The recorder's `--check` run says whether the recording is still the tree's code; these tests say whether this crate
//! gives the same answers.

use std::path::Path;
#[allow(clippy::disallowed_types, reason = "test: the ignored live check runs the Node recorder as a child process")]
use std::process::Command;

use mixdog_markdown_ansi::format::{Context, format_token};
use mixdog_markdown_ansi::heal::heal_streaming_markdown_tail;
use mixdog_markdown_ansi::lexer::{Token, TokenKind};
use mixdog_markdown_ansi::render::has_markdown_syntax;
use mixdog_markdown_ansi::repl_render::render_repl_markdown_with;
use mixdog_markdown_ansi::stream::{
    StreamFinalPatch, StreamingParts, build_stream_final_patch, find_open_fence_start, lex_streaming_tail,
    reset_all_streaming_markdown_stable_prefixes, resolve_streaming_markdown_parts, window_plain_streaming_text,
};
use mixdog_termtext::grapheme::byte_to_utf16;
use mixdog_tui_style::color::Styler;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const GOLDEN: &str = include_str!("goldens/stream.json");
const STRINGS: &str = include_str!("corpus/strings.json");
const EDGE: &str = include_str!("corpus/edge.json");

const SHOWN: usize = 12;
const DIGEST: usize = 8;
const REPL_DIGEST: usize = 16;
/// What the recorder writes for a prefix with no markdown syntax in the tail column.
const NO_TAIL: &str = "--------";

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

/// Stands for a member whose value is `undefined` in the recorded Node tokens: the recorder's `canonical` writes the word.
const UNDEFINED: &str = "\u{1}undefined\u{1}";

/// The members marked leaves on a token that the lexer's tokens do not carry: the recorder digests the raw marked tokens, so
/// a link or image from a bracket form has `title: null` (an autolink has no `title`), a list item that is no task has
/// `checked: undefined` and a table cell of an unaligned column has `align: null`, all of which `canonical` writes out.
fn as_marked_shaped(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(as_marked_shaped),
        Value::Object(map) => {
            map.values_mut().for_each(as_marked_shaped);
            let kind = map.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
            let raw_opens_bracket = map.get("raw").and_then(Value::as_str).is_some_and(|raw| raw.starts_with('['));
            if (kind == "image" || (kind == "link" && raw_opens_bracket)) && !map.contains_key("title") {
                map.insert("title".to_owned(), Value::Null);
            }
            // A table cell carries no type, and `align: null` when its column has no alignment.
            if !map.contains_key("type") && map.contains_key("header") && !map.contains_key("align") {
                map.insert("align".to_owned(), Value::Null);
            }
            if kind == "list_item" && !map.contains_key("checked") {
                map.insert("checked".to_owned(), Value::String(UNDEFINED.to_owned()));
            }
        }
        _ => {}
    }
}

/// `JSON.stringify` of the value with its object keys sorted (the recorder's `canonical`).
fn canonical(value: &Value) -> String {
    match value {
        Value::String(text) if text == UNDEFINED => "undefined".to_owned(),
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

fn clip(text: &str) -> String {
    let mut shown: String = text.chars().take(120).collect();
    if text.chars().count() > 120 {
        shown.push_str("...");
    }
    shown
}

fn parts_value(parts: &StreamingParts) -> Value {
    json!({
        "plain": parts.plain,
        "openFence": parts.open_fence,
        "stablePrefix": parts.stable_prefix,
        "stableChunks": parts.stable_chunks.iter().map(|chunk| &**chunk).collect::<Vec<_>>(),
        "unstableSuffix": parts.unstable_suffix,
        "unstableForRender": parts.unstable_for_render,
    })
}

/// The tokens of the segments `renderTokenAnsiSegments(prefix, { trimPartialFences: true })` draws, as the recorder digests
/// them: the streaming tail's tokens without the spaces and without the blocks that format to nothing.
fn tail_value(prefix: &str) -> Option<Value> {
    if !has_markdown_syntax(prefix) {
        return None;
    }
    let context = Context::at_width(80);
    let tokens = lex_streaming_tail(prefix);
    let drawn: Vec<&Token> = tokens
        .iter()
        .filter(|token| match token.kind {
            TokenKind::Space => false,
            TokenKind::Table => true,
            _ => !format_token(token, &context).trim_matches('\n').is_empty(),
        })
        .collect();
    let mut value = serde_json::to_value(&drawn).ok()?;
    as_marked_shaped(&mut value);
    Some(value)
}

/// The columns of one document, computed in the order the recorder calls them for each prefix.
struct Columns {
    parts: Vec<(Value, String)>,
    parts_no_key: Vec<(Value, String)>,
    heal: Vec<(Value, String)>,
    window: Vec<(Value, String)>,
    fence: Vec<(Value, String)>,
    tail: Vec<(Value, String)>,
}

fn column_entry(value: Value) -> (Value, String) {
    let text = canonical(&value);
    let hashed = digest(&text, DIGEST);
    (value, hashed)
}

fn stream_document(id: &str, text: &str) -> (Vec<String>, Columns) {
    reset_all_streaming_markdown_stable_prefixes();
    let key = format!("doc:{id}");
    let fence_key = format!("fence:{id}");
    let mut columns = Columns {
        parts: Vec::new(),
        parts_no_key: Vec::new(),
        heal: Vec::new(),
        window: Vec::new(),
        fence: Vec::new(),
        tail: Vec::new(),
    };
    let mut cuts = Vec::new();
    let mut prefix = String::new();
    for ch in text.chars() {
        prefix.push(ch);
        cuts.push(prefix.clone());
        columns.parts.push(column_entry(parts_value(&resolve_streaming_markdown_parts(&prefix, Some(&key)))));
        columns.parts_no_key.push(column_entry(parts_value(&resolve_streaming_markdown_parts(&prefix, None))));
        columns.heal.push(column_entry(Value::String(heal_streaming_markdown_tail(&prefix))));
        columns.window.push(column_entry(json!([
            window_plain_streaming_text(&prefix, 20, 3, Some(&key)),
            window_plain_streaming_text(&prefix, 7, 2, None),
        ])));
        let open = find_open_fence_start(&prefix, Some(&fence_key));
        columns.fence.push(column_entry(
            open.map_or(Value::Null, |open| json!({ "index": byte_to_utf16(&prefix, open.index), "lang": open.lang })),
        ));
        columns.tail.push(match tail_value(&prefix) {
            Some(tokens) => column_entry(tokens),
            None => (Value::Null, NO_TAIL.to_owned()),
        });
    }
    (cuts, columns)
}

#[test]
fn the_streaming_functions_answer_every_prefix_as_the_node_ones_do() {
    // The recording fixes the display-width policy off; this process resolves its own once, at the first width it measures.
    // SAFETY: no other test of this binary measures a width or reads the environment, and no width was measured yet.
    unsafe { std::env::set_var("MIXDOG_TUI_AMBIGUOUS_WIDE", "0") };

    let golden = parse(GOLDEN);
    let recorded = entries(&golden["entries"]);
    assert!(
        !recorded.is_empty(),
        "tests/goldens/stream.json is not recorded: node tests/recorders/record-stream.mjs --tree C:/Project/mixdog --write tests/goldens/stream.json"
    );
    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for entry in recorded {
        let (id, text) = (id_of(entry), text_of(entry));
        let (cuts, columns) = stream_document(id, text);
        if cuts.len() as u64 != entry["count"].as_u64().unwrap_or(0) {
            failures.push(format!("{id}: {} prefixes, recorded {}", cuts.len(), entry["count"]));
            continue;
        }
        let named: [(&str, &Vec<(Value, String)>); 6] = [
            ("parts", &columns.parts),
            ("partsNoKey", &columns.parts_no_key),
            ("heal", &columns.heal),
            ("window", &columns.window),
            ("fence", &columns.fence),
            ("tail", &columns.tail),
        ];
        for (name, column) in named {
            let expected = entry[name].as_str().unwrap_or("");
            for (at, (value, got)) in column.iter().enumerate() {
                checked += 1;
                let want = expected.get(at * DIGEST..(at + 1) * DIGEST).unwrap_or("");
                if got != want {
                    failures.push(format!(
                        "{id} {name} at prefix {} ({:?}): got {}",
                        at + 1,
                        clip(&cuts[at]),
                        clip(&canonical(value))
                    ));
                    break;
                }
            }
        }
    }
    assert!(checked > 0, "the recording holds no streaming rows");
    let more = failures.len().saturating_sub(SHOWN);
    failures.truncate(SHOWN);
    assert!(failures.is_empty(), "{} differences (first {SHOWN}):\n{}\n... and {more} more", failures.len() + more, failures.join("\n"));
}

#[test]
fn the_repl_renderer_draws_the_node_bytes_at_every_width_with_and_without_colour() {
    let golden = parse(GOLDEN);
    let widths: Vec<usize> = entries(&golden["widths"]).iter().filter_map(|width| width.as_u64()).map(|width| width as usize).collect();
    assert_eq!(widths, [40, 80, 120], "the recorded widths");
    let docs: Vec<Value> = entries(&golden["entries"]).to_vec();
    let groups = [("docs", docs), ("strings", entries(&parse(STRINGS)).to_vec()), ("edge", entries(&parse(EDGE)).to_vec())];
    let styles = [("on", Styler::new(true, true)), ("off", Styler::new(false, true))];
    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for (colour, styler) in styles {
        for (group, inputs) in &groups {
            let recorded = entries(&golden["repl"][colour][*group]);
            if recorded.len() != inputs.len() {
                failures.push(format!("{colour} {group}: {} inputs, {} recorded", inputs.len(), recorded.len()));
                continue;
            }
            for (input, row) in inputs.iter().zip(recorded) {
                let row = row.as_str().unwrap_or("");
                for (at, width) in widths.iter().enumerate() {
                    checked += 1;
                    let rendered = render_repl_markdown_with(text_of(input), *width, styler);
                    let want = row.get(at * REPL_DIGEST..(at + 1) * REPL_DIGEST).unwrap_or("");
                    if digest(&rendered, REPL_DIGEST) != want {
                        failures.push(format!("{colour} {group} {} at width {width}: got {}", id_of(input), clip(&rendered)));
                    }
                }
            }
        }
    }
    let full = entries(&golden["repl"]["offFull"]);
    assert_eq!(full.len(), groups[0].1.len(), "the recorded strings of the documents");
    for (input, want) in groups[0].1.iter().zip(full) {
        checked += 1;
        let rendered = render_repl_markdown_with(text_of(input), 40, styles[1].1);
        if Some(rendered.as_str()) != want.as_str() {
            failures.push(format!("off {} at width 40: got {:?}, recorded {:?}", id_of(input), clip(&rendered), clip(want.as_str().unwrap_or(""))));
        }
    }
    assert!(checked > 0, "the recording holds no rendering");
    let more = failures.len().saturating_sub(SHOWN);
    failures.truncate(SHOWN);
    assert!(failures.is_empty(), "{} differences (first {SHOWN}):\n{}\n... and {more} more", failures.len() + more, failures.join("\n"));
}

#[test]
fn the_final_patch_is_the_node_one_for_every_recorded_case() {
    let golden = parse(GOLDEN);
    let cases = entries(&golden["finalize"]);
    assert!(!cases.is_empty(), "the recording holds no finalize case");
    for case in cases {
        let columns = case["columns"].as_u64().unwrap_or(0) as usize;
        let got = build_stream_final_patch(case["raw"].as_str().unwrap_or(""), case["rendered"].as_str().unwrap_or(""), columns);
        let want = match &case["patch"] {
            Value::Null => None,
            patch => Some(StreamFinalPatch {
                output: patch["output"].as_str().unwrap_or("").to_owned(),
                changed_rows: patch["changedRows"].as_u64().unwrap_or(0) as usize,
                total_rows: patch["totalRows"].as_u64().unwrap_or(0) as usize,
            }),
        };
        assert_eq!(got, want, "raw {:?}, rendered {:?}, columns {}", case["raw"], case["rendered"], case["columns"]);
    }
}

#[test]
#[ignore = "runs node over the reference checkout C:/Project/mixdog (read only)"]
#[allow(clippy::disallowed_types, reason = "test: runs the Node recorder as a child process")]
fn live_stream_golden_matches_the_node_code() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new("node")
        .arg(crate_dir.join("tests/recorders/record-stream.mjs"))
        .args(["--tree", "C:/Project/mixdog", "--check"])
        .arg(crate_dir.join("tests/goldens/stream.json"))
        .status()
        .expect("node runs");
    assert!(status.success(), "the recorder found the golden different from a fresh recording");
}
