//! The formatter against the recording of the Node product's: `tests/goldens/format.json`, written by
//! `tests/recorders/record-format.mjs` from `renderTokenAnsiSegments(text, { width })` of
//! `src/tui/markdown/render-ansi.mjs` over the files of `tests/corpus`, at the widths 20, 40, 80, 120 and 200 under three
//! themes (all fifteen for the 20 shortest documents). The ANSI bytes must be the same. The recorder's `--check` run
//! says whether the recording is still the tree's renderer; these tests say whether this crate renders the same bytes.

use std::path::Path;
#[allow(clippy::disallowed_types, reason = "test: the ignored live check runs the Node recorder as a child process")]
use std::process::Command;

use mixdog_markdown_ansi::format::{colorize_diff_line, looks_like_unified_diff, styles};
use mixdog_markdown_ansi::render::{RenderOptions, render_token_ansi_segments};
use mixdog_tui_style::set_theme;
use serde_json::Value;
use sha2::{Digest, Sha256};

const GOLDEN: &str = include_str!("goldens/format.json");
const STRINGS: &str = include_str!("corpus/strings.json");
const EDGE: &str = include_str!("corpus/edge.json");
const DOCS: &str = include_str!("corpus/docs.json");

/// What the recorder writes for a table block.
const TABLE: &str = "\u{2}table";
const WIDTHS: [usize; 5] = [20, 40, 80, 120, 200];
const SHOWN: usize = 12;

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

fn segments_of(text: &str, width: usize) -> Vec<String> {
    render_token_ansi_segments(text, RenderOptions { width, trim_partial_fences: false })
        .iter()
        .map(|segment| segment.ansi().map_or_else(|| TABLE.to_owned(), str::to_owned))
        .collect()
}

/// The first 16 hex digits of the SHA-256 of the segments joined by U+0000.
fn digest(segments: &[String]) -> String {
    let bytes = Sha256::digest(segments.join("\u{0}").as_bytes());
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out.truncate(16);
    out
}

/// The digests of a text at every width, under the theme now active.
fn row(text: &str) -> String {
    WIDTHS.iter().map(|width| digest(&segments_of(text, *width))).collect()
}

fn clip(text: &str) -> String {
    let mut shown: String = text.chars().take(100).collect();
    if text.chars().count() > 100 {
        shown.push_str("...");
    }
    shown
}

/// The first segment that differs, for a failure message.
fn first_segment_difference(got: &[String], want: &[Value]) -> String {
    for (at, expected) in want.iter().enumerate() {
        let expected = expected.as_str().unwrap_or("");
        match got.get(at) {
            Some(segment) if segment == expected => {}
            Some(segment) => return format!("segment {at}: got {:?}, recorded {:?}", clip(segment), clip(expected)),
            None => return format!("segment {at} is missing, recorded {:?}", clip(expected)),
        }
    }
    format!("{} segments, recorded {}", got.len(), want.len())
}

#[test]
fn the_rendered_segments_equal_the_node_ones_byte_for_byte() {
    // The recording fixes the display-width policy off; this process resolves its own once, at the first width it measures.
    // SAFETY: nothing else in this test binary reads or writes the environment, and no width was measured yet.
    unsafe { std::env::set_var("MIXDOG_TUI_AMBIGUOUS_WIDE", "0") };

    let golden = parse(GOLDEN);
    assert!(
        golden["entries"].is_object(),
        "tests/goldens/format.json is not recorded: node tests/recorders/record-format.mjs --tree C:/Project/mixdog --write tests/goldens/format.json"
    );
    let themes: Vec<&str> = entries(&golden["themes"]).iter().filter_map(Value::as_str).collect();
    let all_themes: Vec<&str> = entries(&golden["allThemes"]).iter().filter_map(Value::as_str).collect();
    let corpus = [("strings", parse(STRINGS)), ("edge", parse(EDGE)), ("docs", parse(DOCS))];
    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;

    for theme in &all_themes {
        set_theme(theme);
        let theme_at = themes.iter().position(|id| id == theme);
        for (group, texts) in &corpus {
            let recorded = entries(&golden["entries"][group]);
            if recorded.len() != entries(texts).len() {
                failures.push(format!("{group}: {} inputs, {} recorded", entries(texts).len(), recorded.len()));
                continue;
            }
            for (input, want) in entries(texts).iter().zip(recorded) {
                if id_of(input) != id_of(want) {
                    failures.push(format!("{group}: input {} is recorded as {}", id_of(input), id_of(want)));
                    continue;
                }
                let expected = match theme_at {
                    Some(at) => want["themes"][at].as_str(),
                    None => want["all"][*theme].as_str(),
                };
                let Some(expected) = expected else { continue };
                checked += 1;
                let got = row(text_of(input));
                if got != expected {
                    let at = got.as_bytes().chunks(16).zip(expected.as_bytes().chunks(16)).position(|(a, b)| a != b).unwrap_or(0);
                    failures.push(format!("{group} {} under {theme} at width {}: the digest differs", id_of(input), WIDTHS[at]));
                }
            }
        }
        if theme_at == Some(0) {
            for want in entries(&golden["full"]) {
                let Some(input) = entries(&corpus[1].1).iter().find(|entry| id_of(entry) == id_of(want)) else {
                    failures.push(format!("full: {} is not an edge input", id_of(want)));
                    continue;
                };
                for width in [20usize, 80] {
                    let recorded = entries(&want[format!("w{width}")]);
                    let got = segments_of(text_of(input), width);
                    let same = got.len() == recorded.len() && got.iter().zip(recorded).all(|(a, b)| Some(a.as_str()) == b.as_str());
                    if !same {
                        failures.push(format!("edge {} at width {width}: {}", id_of(want), first_segment_difference(&got, recorded)));
                    }
                }
            }
            let unified: String = [&corpus[0].1, &corpus[1].1]
                .iter()
                .flat_map(|texts| entries(texts))
                .map(|entry| if looks_like_unified_diff(text_of(entry)) { '1' } else { '0' })
                .collect();
            if Some(unified.as_str()) != golden["unified"].as_str() {
                failures.push("looksLikeUnifiedDiff differs from the recorded truth table".to_owned());
            }
            let colors = styles();
            for want in entries(&golden["diffLines"]) {
                let got = colorize_diff_line(want["line"].as_str().unwrap_or(""), &colors.extra);
                if Some(got.as_str()) != want["out"].as_str() {
                    failures.push(format!("colorizeDiffLine of {}: got {:?}", clip(&format!("{:?}", want["line"])), clip(&got)));
                }
            }
        }
    }
    assert!(checked > 0, "the recording holds no rendering");
    let more = failures.len().saturating_sub(SHOWN);
    failures.truncate(SHOWN);
    assert!(failures.is_empty(), "{} differences (first {SHOWN}):\n{}\n... and {more} more", failures.len() + more, failures.join("\n"));
}

#[test]
#[ignore = "runs node over the reference checkout C:/Project/mixdog (read only)"]
#[allow(clippy::disallowed_types, reason = "test: runs the Node recorder as a child process")]
fn live_format_golden_matches_the_node_renderer() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new("node")
        .arg(crate_dir.join("tests/recorders/record-format.mjs"))
        .args(["--tree", "C:/Project/mixdog", "--check"])
        .arg(crate_dir.join("tests/goldens/format.json"))
        .status()
        .expect("node runs");
    assert!(status.success(), "the recorder found the golden different from a fresh recording");
}
