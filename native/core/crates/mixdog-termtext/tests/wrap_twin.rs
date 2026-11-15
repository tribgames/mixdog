//! The twin of wrap-ansi 10.0.2, slice-ansi 9.0.0, cli-truncate 6.0.0, the Ink fork's wrap-text / measure-text /
//! sanitize-ansi, `@alcalzone/ansi-tokenize` 0.3.0, `ansi-line-wrap.mjs` and the SGR parser of `AnsiText.jsx`: every
//! row of `goldens/wrap.json` (recorded by `tests/recorders/record-wrap.mjs` from the Node code over the corpus, at the
//! widths 1, 2, 3, 10, 20, 40, 80, 120 and 200, with the display-width policy on and off) is answered by the Rust port
//! and must give the same text.

use std::fmt::Debug;
use std::path::Path;
#[allow(clippy::disallowed_types, reason = "test: the ignored live check runs the Node recorder as a child process")]
use std::process::Command;

use mixdog_termtext::ansi::{StyledToken, styled_chars_from_tokens, styled_chars_to_string, tokenize_styled};
use mixdog_termtext::slice::slice_ansi;
use mixdog_termtext::spans::{SgrColor, StyledRun, parse_sgr, xterm256_rgb};
use mixdog_termtext::truncate::{TruncateOptions, TruncatePosition, truncate_with};
use mixdog_termtext::wrap::{
    WrapMode, WrapOptions, hard_wrap_ansi_lines_with, measure_text_with, sanitize_ansi, slice_text_by_display_width_with,
    wrap_ansi, wrap_lines, wrap_text_with,
};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/wrap.json");
const SHOWN: usize = 12;
const CLIP: usize = 110;

/// The theme keys the stub theme of the recorder gives the named colours, by SGR colour index 0 to 15 (`30` and `90`
/// are `theme.subtle`, `31` and `91` `theme.error`, ...).
const FOREGROUND_NAMES: [&str; 16] = [
    "S", "E", "G", "W", "C", "ansi:magenta", "ansi:cyan", "T", "S", "E", "G", "W", "C", "ansi:magentaBright",
    "ansi:cyanBright", "X",
];
const BACKGROUND_NAMES: [&str; 16] = [
    "ansi:black", "ansi:red", "ansi:green", "ansi:yellow", "ansi:blue", "ansi:magenta", "ansi:cyan", "ansi:white",
    "ansi:blackBright", "ansi:redBright", "ansi:greenBright", "ansi:yellowBright", "ansi:blueBright",
    "ansi:magentaBright", "ansi:cyanBright", "ansi:whiteBright",
];

fn clip(text: &str) -> String {
    let mut shown: String = text.chars().take(CLIP).collect();
    if text.chars().count() > CLIP {
        shown.push_str("...");
    }
    shown
}

fn note<T: PartialEq + Debug>(failures: &mut Vec<String>, what: &str, text: &str, got: &T, want: &T) {
    if got != want {
        failures.push(format!(
            "{what} of {}: got {}, recorded {}",
            clip(&format!("{text:?}")),
            clip(&format!("{got:?}")),
            clip(&format!("{want:?}"))
        ));
    }
}

/// The golden as JSON a Rust string can hold: the recorder writes what Node holds, and Node cuts inside a surrogate
/// pair, so the golden has `\ud83d` and `\ude42` as strings of their own, which no JSON reader of Rust takes. Every
/// escape of a surrogate that is not half of a pair inside one string is read as U+FFFD, the character the lone half
/// becomes when Node writes the string to a terminal.
fn readable(golden: &str) -> String {
    fn unit(bytes: &[u8], at: usize) -> Option<u32> {
        if bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u') {
            std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok().and_then(|hex| u32::from_str_radix(hex, 16).ok())
        } else {
            None
        }
    }
    let bytes = golden.as_bytes();
    let mut out = String::with_capacity(golden.len());
    let mut at = 0;
    let mut copied = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' {
            match unit(bytes, at) {
                Some(0xD800..=0xDBFF) if matches!(unit(bytes, at + 6), Some(0xDC00..=0xDFFF)) => {
                    at += 12;
                    continue;
                }
                Some(0xD800..=0xDFFF) => {
                    out.push_str(&golden[copied..at]);
                    out.push_str("\\ufffd");
                    at += 6;
                    copied = at;
                    continue;
                }
                _ => at += 2,
            }
        } else {
            at += 1;
        }
    }
    out.push_str(&golden[copied..]);
    out
}

fn count(value: &Value) -> usize {
    value.as_u64().and_then(|n| usize::try_from(n).ok()).expect("a count")
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("an array").iter().map(|item| item.as_str().expect("a string").to_owned()).collect()
}

fn text_of(value: &Value) -> String {
    value.as_str().expect("a string").to_owned()
}

fn foreground_name(color: Option<SgrColor>) -> String {
    match color {
        None => "D".to_owned(),
        Some(SgrColor::Indexed(index)) => match xterm256_rgb(index) {
            Some((red, green, blue)) => format!("rgb({red},{green},{blue})"),
            None => FOREGROUND_NAMES[usize::from(index)].to_owned(),
        },
        Some(SgrColor::Rgb(red, green, blue)) => format!("rgb({red},{green},{blue})"),
    }
}

fn background_name(color: Option<SgrColor>) -> Value {
    match color {
        None => Value::Null,
        Some(SgrColor::Indexed(index)) => match xterm256_rgb(index) {
            Some((red, green, blue)) => json!(format!("rgb({red},{green},{blue})")),
            None => json!(BACKGROUND_NAMES[usize::from(index)]),
        },
        Some(SgrColor::Rgb(red, green, blue)) => json!(format!("rgb({red},{green},{blue})")),
    }
}

fn run_json(run: &StyledRun) -> Value {
    let style = &run.style;
    json!([
        run.text,
        foreground_name(style.foreground),
        background_name(style.background),
        style.bold,
        style.dim,
        style.italic,
        style.underline,
        style.inverse
    ])
}

fn token_json(token: &StyledToken) -> Value {
    match token {
        StyledToken::Char { value, full_width } => json!(["c", value, full_width]),
        StyledToken::Ansi(code) => json!(["a", code.code, code.end_code]),
        StyledToken::Control(code) => json!(["o", code]),
    }
}

fn position_of(name: &str) -> TruncatePosition {
    match name {
        "start" => TruncatePosition::Start,
        "middle" => TruncatePosition::Middle,
        "end" => TruncatePosition::End,
        other => panic!("a position the recorder does not write: {other}"),
    }
}

fn mode_of(name: &str) -> WrapMode {
    match name {
        "wrap" => WrapMode::Wrap,
        "hard" => WrapMode::Hard,
        "truncate-end" => WrapMode::TruncateEnd,
        "truncate-middle" => WrapMode::TruncateMiddle,
        "truncate-start" => WrapMode::TruncateStart,
        other => panic!("a wrap mode the recorder does not write: {other}"),
    }
}

#[test]
fn every_recorded_answer_is_the_same() {
    let golden: Value = serde_json::from_str(&readable(GOLDEN)).expect("the golden parses");
    let widths: Vec<usize> = golden["widths"].as_array().expect("widths").iter().map(count).collect();
    let wrap_options: Vec<WrapOptions> = golden["wrapAnsiOptions"]
        .as_array()
        .expect("wrap options")
        .iter()
        .map(|o| WrapOptions { hard: flag(o, "hard"), word_wrap: flag(o, "wordWrap"), trim: flag(o, "trim") })
        .collect();
    let truncate_variants: Vec<(TruncatePosition, bool, bool)> = golden["truncateVariants"]
        .as_array()
        .expect("truncate variants")
        .iter()
        .map(|o| (position_of(o["position"].as_str().expect("a position")), flag(o, "space"), flag(o, "preferTruncationOnSpace")))
        .collect();
    let modes: Vec<WrapMode> = strings(&golden["wrapModes"]).iter().map(|name| mode_of(name)).collect();
    let rows = golden["rows"].as_array().expect("rows");
    assert!(rows.len() > 100, "the corpus is the recorded one");

    let mut failures: Vec<String> = Vec::new();
    for row in rows {
        let row = row.as_array().expect("a row");
        let text = row[0].as_str().expect("text");

        note(&mut failures, "sanitize_ansi", text, &sanitize_ansi(text), &text_of(&row[1]));
        for (wide, recorded) in [(true, &row[2]), (false, &row[3])] {
            let size = measure_text_with(text, wide);
            note(&mut failures, &format!("measure_text_with({wide})"), text, &(size.width, size.height), &(count(&recorded[0]), count(&recorded[1])));
        }

        let tokens = tokenize_styled(text, None);
        let token_rows = Value::Array(tokens.iter().map(token_json).collect());
        note(&mut failures, "tokenize_styled", text, &token_rows, &row[4][0]);
        let rendered = styled_chars_to_string(&styled_chars_from_tokens(&tokens));
        note(&mut failures, "styled_chars_to_string", text, &rendered, &text_of(&row[4][1]));

        if !row[5].is_null() {
            let lines = Value::Array(
                parse_sgr(text).iter().map(|line| Value::Array(line.runs.iter().map(run_json).collect())).collect(),
            );
            note(&mut failures, "parse_sgr", text, &lines, &row[5]);
        }

        let per_width = row[6].as_array().expect("per width");
        for (at, &width) in widths.iter().enumerate() {
            let entry = per_width[at].as_array().expect("an entry");

            let wrapped: Vec<String> = wrap_options.iter().map(|&options| wrap_ansi(text, width, options)).collect();
            note(&mut failures, &format!("wrap_ansi at {width}"), text, &wrapped, &strings(&entry[0]));

            let truncated: Vec<String> = truncate_variants
                .iter()
                .map(|&(position, space, prefer_truncation_on_space)| {
                    let options = TruncateOptions { position, space, prefer_truncation_on_space, ..TruncateOptions::default() };
                    truncate_with(text, width, options)
                })
                .collect();
            note(&mut failures, &format!("truncate_with at {width}"), text, &truncated, &strings(&entry[1]));

            let ranges = [(0, Some(width)), (width / 2, None), (1, Some(width + 1))];
            let sliced: Vec<String> = ranges.iter().map(|&(start, end)| slice_ansi(text, start, end)).collect();
            note(&mut failures, &format!("slice_ansi at {width}"), text, &sliced, &strings(&entry[2]));

            let line_wrap: Vec<Vec<String>> = vec![wrap_lines(text, width, false), wrap_lines(text, width, true)];
            let recorded_line_wrap: Vec<Vec<String>> =
                entry[3].as_array().expect("line wrap").iter().map(strings).collect();
            note(&mut failures, &format!("wrap_lines at {width}"), text, &line_wrap, &recorded_line_wrap);

            for (wide, dependent) in [(true, &entry[4]), (false, &entry[5])] {
                let texts: Vec<String> = modes.iter().map(|&mode| wrap_text_with(text, width, mode, wide)).collect();
                note(&mut failures, &format!("wrap_text_with at {width}, policy {wide}"), text, &texts, &strings(&dependent[0]));
                note(
                    &mut failures,
                    &format!("hard_wrap_ansi_lines_with at {width}, policy {wide}"),
                    text,
                    &hard_wrap_ansi_lines_with(text, width, wide),
                    &strings(&dependent[1]),
                );
                note(
                    &mut failures,
                    &format!("slice_text_by_display_width_with at {width}, policy {wide}"),
                    text,
                    &slice_text_by_display_width_with(text, width / 3, width, wide),
                    &text_of(&dependent[2]),
                );
            }
        }
    }
    let shown: Vec<&String> = failures.iter().take(SHOWN).collect();
    assert!(failures.is_empty(), "{} answers differ, first {SHOWN}: {shown:#?}", failures.len());
}

/// Runs the recorder over the reference checkout and compares with the golden. Needs node and the checkout of the
/// Node tree, which this crate otherwise never reads: run it by hand.
#[test]
#[ignore = "runs node over the reference checkout C:/Project/mixdog (read only)"]
#[allow(clippy::disallowed_types, reason = "test: runs the Node recorder as a child process")]
fn live_wrap_golden_matches_the_node_packages() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new("node")
        .arg(crate_dir.join("tests/recorders/record-wrap.mjs"))
        .args(["--tree", "C:/Project/mixdog", "--check"])
        .arg(crate_dir.join("tests/goldens/wrap.json"))
        .status()
        .expect("node runs");
    assert!(status.success(), "the recorder found the golden different from a fresh recording");
}
