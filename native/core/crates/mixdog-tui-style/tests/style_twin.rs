//! The twin of the Node style code: every row of `goldens/style.json` (recorded by `tests/recorders/record-style.mjs`
//! from `src/tui/themes`, `theme.mjs`, `figures.mjs`, `statusline-ansi-bridge.mjs`, `statusline/ansi.mjs`,
//! `spinner-verbs.mjs`, `spinner-meta.mjs`, `time-format.mjs` and chalk's `supports-color` / Ink's `colorize`) is run
//! through the Rust port and must give the same answer.

use std::collections::BTreeMap;
use std::process::Command;

use mixdog_js::{to_number, to_number_of};
use mixdog_tui_style::bridge::{StatuslineColors, normalize_statusline_ansi, statusline_footer_identity_changed};
use mixdog_tui_style::color::{Style, Styler, rgb_to_ansi256, strip_ansi, visible_width};
use mixdog_tui_style::color_level::{ColorEnvironment, ink_colorize};
use mixdog_tui_style::palette::{BASE, DEFAULT_THEME_ID, THEME_ALIASES, THEMES};
use mixdog_tui_style::spinner_meta::{Quiet, SpinnerMetaInput, Thinking, build_spinner_meta, is_reduced_motion};
use mixdog_tui_style::spinner_verbs::{
    SPINNER_FRAMES, SPINNER_MODE_OVERRIDE_VERBS, SPINNER_VERBS, spinner_verb_for, spinner_verb_in,
};
use mixdog_tui_style::theme::{
    AGENT_CALL_MARKER, AGENT_RESPONSE_MARKER, RESULT_GUTTER, RESULT_GUTTER_CONT, TURN_MARKER, Color, Palette,
};
use mixdog_tui_style::time_format::{DurationOptions, format_duration, format_elapsed};
use mixdog_tui_style::{
    Key, current_palette, figures, get_theme_setting, get_theme_version, list_themes, osc_background_sequence, set_theme,
    terminal_background_sequence,
};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/style.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden parses")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn number(value: &Value) -> f64 {
    value.as_f64().expect("a number")
}

fn palette_css(palette: &Palette) -> Vec<String> {
    palette.0.iter().map(|color| color.css()).collect()
}

fn recorded_palette(value: &Value) -> Vec<String> {
    value.as_array().expect("a palette").iter().map(|c| text(c).to_owned()).collect()
}

#[test]
fn the_palettes_are_the_recorded_ones() {
    let golden = golden();
    let palettes = &golden["palettes"];
    let keys: Vec<&str> = palettes["keys"].as_array().expect("keys").iter().map(text).collect();
    let rust_keys: Vec<&str> = Key::ALL.iter().map(|key| key.name()).collect();
    assert_eq!(rust_keys, keys);
    assert_eq!(palette_css(&BASE), recorded_palette(&palettes["base"]));

    let themes = palettes["themes"].as_array().expect("themes");
    assert_eq!(THEMES.len(), themes.len());
    for (entry, recorded) in THEMES.iter().zip(themes) {
        assert_eq!(entry.id, text(&recorded["id"]));
        assert_eq!(entry.label, text(&recorded["label"]), "{}", entry.id);
        assert_eq!(entry.description, text(&recorded["description"]), "{}", entry.id);
        assert_eq!(palette_css(&entry.palette), recorded_palette(&recorded["palette"]), "{}", entry.id);
    }
    let order: Vec<&str> = palettes["order"].as_array().expect("order").iter().map(text).collect();
    assert_eq!(THEMES.iter().map(|entry| entry.id).collect::<Vec<_>>(), order);
    let aliases: BTreeMap<&str, &str> = palettes["aliases"]
        .as_object()
        .expect("aliases")
        .iter()
        .map(|(alias, id)| (alias.as_str(), text(id)))
        .collect();
    assert_eq!(THEME_ALIASES.iter().copied().collect::<BTreeMap<_, _>>(), aliases);
    assert_eq!(DEFAULT_THEME_ID, text(&palettes["defaultId"]));
    assert!(palettes["basicIsDefaultSeed"].as_bool().expect("flag"), "the live theme starts as the registry's basic");
}

fn active_ids() -> Vec<&'static str> {
    list_themes().into_iter().filter(|row| row.current).map(|row| row.id).collect()
}

/// The theme runtime is process-wide state, so everything that switches the theme is one test.
#[test]
fn the_theme_runtime_switches_like_the_node_one() {
    let golden = golden();
    let theme = &golden["theme"];
    let initial = &theme["initial"];
    assert_eq!(get_theme_setting(), text(&initial["id"]));
    assert_eq!(get_theme_version() as f64, number(&initial["version"]));
    assert_eq!(palette_css(&current_palette()), recorded_palette(&initial["theme"]));
    let listed = list_themes();
    let recorded_list = initial["list"].as_array().expect("list");
    assert_eq!(listed.len(), recorded_list.len());
    for (row, recorded) in listed.iter().zip(recorded_list) {
        assert_eq!(
            (row.id, row.label, row.description, row.current),
            (text(&recorded["id"]), text(&recorded["label"]), text(&recorded["description"]), recorded["current"].as_bool().unwrap())
        );
    }

    let mut version = get_theme_version();
    for row in theme["setTheme"].as_array().expect("rows") {
        let input = text(&row["input"]);
        let result = set_theme(input);
        assert_eq!(
            (result.id, result.label, result.description),
            (text(&row["result"]["id"]), text(&row["result"]["label"]), text(&row["result"]["description"])),
            "{input:?}"
        );
        assert_eq!(terminal_background_sequence(&current_palette()), text(&row["osc"]), "{input:?}");
        assert_eq!((get_theme_version() - version) as f64, number(&row["versionDelta"]), "{input:?}");
        version = get_theme_version();
        assert_eq!(get_theme_setting(), text(&row["active"]), "{input:?}");
        let current: Vec<&str> = row["list"].as_array().expect("list").iter().map(text).collect();
        assert_eq!(active_ids(), current, "{input:?}");
        assert_eq!(palette_css(&current_palette()), recorded_palette(&row["theme"]), "{input:?}");
    }
    set_theme("basic");

    for row in theme["background"].as_array().expect("rows") {
        assert_eq!(osc_background_sequence(text(&row["input"])), text(&row["osc"]), "{:?}", row["input"]);
    }

    let glyphs = &theme["glyphs"];
    assert_eq!(TURN_MARKER, text(&glyphs["turnMarker"]));
    assert_eq!(AGENT_CALL_MARKER, text(&glyphs["agentCall"]));
    assert_eq!(AGENT_RESPONSE_MARKER, text(&glyphs["agentResponse"]));
    assert_eq!(RESULT_GUTTER, text(&glyphs["resultGutter"]));
    assert_eq!(RESULT_GUTTER_CONT, text(&glyphs["resultGutterCont"]));
}

#[test]
fn the_figures_are_the_recorded_glyphs() {
    let golden = golden();
    let recorded = &golden["theme"]["glyphs"]["figures"];
    let on_macos = text(&golden["theme"]["glyphs"]["platform"]) == "darwin";
    assert_eq!(on_macos, cfg!(target_os = "macos"), "the golden was recorded on another platform than this one");
    let ours = [
        ("BLACK_CIRCLE", figures::BLACK_CIRCLE),
        ("BLOCKQUOTE_BAR", figures::BLOCKQUOTE_BAR),
        ("BULLET_OPERATOR", figures::BULLET_OPERATOR),
        ("DOWN_ARROW", figures::DOWN_ARROW),
        ("HR_LINE", figures::HR_LINE),
        ("LEFT_ARROW", figures::LEFT_ARROW),
        ("RESULT_GUTTER_CONT_GLYPH", figures::RESULT_GUTTER_CONT_GLYPH),
        ("RESULT_GUTTER_GLYPH", figures::RESULT_GUTTER_GLYPH),
        ("RIGHT_ARROW", figures::RIGHT_ARROW),
        ("TURN_DONE_MARKER", figures::TURN_DONE_MARKER),
        ("UP_ARROW", figures::UP_ARROW),
    ];
    assert_eq!(recorded.as_object().expect("figures").len(), ours.len());
    for (name, glyph) in ours {
        assert_eq!(glyph, text(&recorded[name]), "{name}");
    }
}

fn edge_value(value: &Value) -> f64 {
    match value.as_str() {
        Some("NaN") => f64::NAN,
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        _ => number(value),
    }
}

#[test]
fn the_256_colour_quantiser_matches_over_the_grid_and_the_edges() {
    let golden = golden();
    let table = &golden["ansi256"];
    let (step, count) = (number(&table["gridStep"]) as usize, number(&table["gridCount"]) as usize);
    let hex = text(&table["gridHex"]);
    assert_eq!(hex.len(), count * count * count * 2);
    let mut at = 0;
    for r in 0..count {
        for g in 0..count {
            for b in 0..count {
                let want = u8::from_str_radix(&hex[at..at + 2], 16).expect("hex");
                at += 2;
                let got = rgb_to_ansi256((r * step) as f64, (g * step) as f64, (b * step) as f64);
                assert_eq!(got, want, "{} {} {}", r * step, g * step, b * step);
            }
        }
    }
    for row in table["edges"].as_array().expect("edges") {
        let row = row.as_array().expect("row");
        let got = rgb_to_ansi256(edge_value(&row[0]), edge_value(&row[1]), edge_value(&row[2]));
        assert_eq!(f64::from(got), number(&row[3]), "{:?}", &row[..3]);
    }
}

const SAMPLES: [&str; 5] = ["x", "", "a\x1b[0mb", "two\nlines", "\x1b[1mbold\x1b[0m tail"];

fn style_named(name: &str) -> Style {
    match name {
        "bold" => Style::Bold,
        "dim" => Style::Dim,
        "italic" => Style::Italic,
        "underline" => Style::Underline,
        "inverse" => Style::Inverse,
        "strike" => Style::Strike,
        "black" => Style::Black,
        "red" => Style::Red,
        "green" => Style::Green,
        "yellow" => Style::Yellow,
        "blue" => Style::Blue,
        "magenta" => Style::Magenta,
        "cyan" => Style::Cyan,
        "white" => Style::White,
        "gray" | "grey" => Style::Gray,
        "brightGreen" => Style::BrightGreen,
        other => panic!("a style the golden has but the port lacks: {other}"),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("an array").iter().map(|v| text(v).to_owned()).collect()
}

#[test]
fn the_statusline_helpers_match_under_every_environment() {
    let golden = golden();
    for case in golden["ansi"].as_array().expect("cases") {
        let name = text(&case["name"]);
        let env: BTreeMap<String, String> =
            case["env"].as_object().expect("env").iter().map(|(k, v)| (k.clone(), text(v).to_owned())).collect();
        let styler = Styler::from_environment(&|key| env.get(key).cloned(), false);
        let recorded = &case["recorded"];
        assert_eq!(styler.enabled(), recorded["enabled"].as_bool().unwrap(), "{name}");
        for (style_name, painted) in recorded["styles"].as_object().expect("styles") {
            let got: Vec<String> = SAMPLES.iter().map(|s| styler.paint(style_named(style_name), s)).collect();
            assert_eq!(got, strings(painted), "{name} {style_name}");
        }
        for row in recorded["rgb"].as_array().expect("rgb") {
            let args = row["args"].as_array().expect("args");
            let style = Style::Rgb(number(&args[0]), number(&args[1]), number(&args[2]));
            let got: Vec<String> = SAMPLES.iter().map(|s| styler.paint(style, s)).collect();
            assert_eq!(got, strings(&row["painted"]), "{name} rgb {args:?}");
        }
        for row in recorded["sgr"].as_array().expect("sgr") {
            let args: Vec<f64> = row["args"].as_array().expect("args").iter().map(to_number).collect();
            assert_eq!(styler.rgb_sgr(args[0], args[1], args[2], false), text(&row["fg"]), "{name} {args:?}");
            assert_eq!(styler.rgb_sgr(args[0], args[1], args[2], true), text(&row["bg"]), "{name} {args:?}");
        }
        let composed: Vec<String> = SAMPLES.iter().map(|s| styler.compose(&[Style::Bold, Style::Red], s)).collect();
        assert_eq!(composed, strings(&recorded["compose"]), "{name}");
        let bare: Vec<String> = SAMPLES.iter().map(|s| styler.compose(&[], s)).collect();
        assert_eq!(bare, strings(&recorded["composeNone"]), "{name}");
        let stripped: Vec<String> = SAMPLES.iter().map(|s| strip_ansi(s)).collect();
        assert_eq!(stripped, strings(&recorded["strip"]), "{name}");
        let widths: Vec<f64> = SAMPLES
            .iter()
            .copied()
            .chain(["\x1b[38;2;1;2;3m\u{d55c}\u{ad6d}\x1b[0m", "\u{1f600}x"])
            .map(|s| visible_width(s) as f64)
            .collect();
        let want: Vec<f64> = recorded["width"].as_array().expect("widths").iter().map(number).collect();
        assert_eq!(widths, want, "{name}");
    }
}

#[test]
fn the_colour_level_matches_over_the_environment_matrix() {
    let golden = golden();
    let cases = golden["supportsColor"].as_array().expect("cases");
    assert!(cases.len() > 400, "the matrix is the recorded one");
    for case in cases {
        let environment = ColorEnvironment {
            vars: case["env"].as_object().expect("env").iter().map(|(k, v)| (k.clone(), text(v).to_owned())).collect(),
            argv: strings(&case["argv"]),
            windows_release: (text(&case["platform"]) == "win32").then(|| text(&case["release"]).to_owned()),
            stream_is_terminal: case["tty"].as_bool().expect("tty"),
        };
        assert_eq!(f64::from(environment.level()), number(&case["level"]), "{case}");
    }
}

#[test]
fn ink_writes_the_recorded_bytes_at_every_level() {
    let golden = golden();
    let ink = &golden["ink"];
    let probes = ink["probes"].as_array().expect("probes");
    let channels: Vec<f64> = ink["grid"]["channels"].as_array().expect("channels").iter().map(number).collect();
    for level in ink["levels"].as_array().expect("levels") {
        assert_eq!(number(&level["level"]), number(&level["chalkLevel"]), "the recorder pins the level it records");
        let chalk_level = number(&level["chalkLevel"]) as i32;
        for (probe, painted) in probes.iter().zip(level["painted"].as_array().expect("painted")) {
            let (input, color, kind) = (text(&probe[0]), text(&probe[1]), text(&probe[2]));
            let want = painted.as_str().map(str::to_owned);
            assert_eq!(ink_colorize(input, color, kind == "background", chalk_level), want, "level {chalk_level} {probe}");
        }
        let grid = level["gridPainted"].as_array().expect("grid");
        let mut at = 0;
        for r in &channels {
            for g in &channels {
                for b in &channels {
                    let color = format!("rgb({r},{g},{b})");
                    let want = text(&grid[at]);
                    assert_eq!(ink_colorize("x", &color, false, chalk_level).as_deref(), Some(want), "level {chalk_level} {color}");
                    at += 1;
                }
            }
        }
        assert_eq!(at, grid.len());
    }
}

fn recorded_colors(value: &Value) -> StatuslineColors {
    let get = |key: &str| text(&value[key]).to_owned();
    StatuslineColors { status: get("STATUS"), subtle: get("SUBTLE"), success: get("SUCCESS"), warning: get("WARNING"), error: get("ERROR") }
}

#[test]
fn the_statusline_bridge_matches_under_every_theme() {
    let golden = golden();
    let bridge = &golden["bridge"];
    let footers = strings(&bridge["footers"]);
    for case in bridge["cases"].as_array().expect("cases") {
        let colors = recorded_colors(&case["colors"]);
        let theme = text(&case["theme"]);
        let normalized: Vec<String> = footers.iter().map(|f| normalize_statusline_ansi(f, &colors, None)).collect();
        assert_eq!(normalized, strings(&case["normalized"]), "{theme}");
        let custom: Vec<String> =
            footers.iter().take(20).map(|f| normalize_statusline_ansi(f, &colors, Some("\x1b[0;0m"))).collect();
        assert_eq!(custom, strings(&case["customReset"]), "{theme}");
    }
    for row in bridge["identity"].as_array().expect("identity") {
        let side = |value: &Value| if value.as_str() == Some("__undefined__") { None } else { Some(value.clone()) };
        let (args, last) = (side(&row["args"]), side(&row["lastArgs"]));
        let got = statusline_footer_identity_changed(args.as_ref(), last.as_ref());
        assert_eq!(got, row["changed"].as_bool().unwrap(), "{row}");
    }
}

/// `input[key]` as `Number`, or the default when the key is absent (a default parameter).
fn number_or(input: &Value, key: &str, default: f64) -> f64 {
    if input.get(key).is_some() { to_number_of(input.get(key)) } else { default }
}

fn quiet_of(input: &Value) -> Option<Quiet> {
    let quiet = input.get("quiet").filter(|q| q.is_object())?;
    let wait = match quiet.get("wait") {
        Some(Value::String(wait)) => wait.clone(),
        _ => String::new(),
    };
    Some(Quiet {
        since: to_number_of(quiet.get("since")),
        wait,
        tool: quiet.get("tool").and_then(Value::as_str).map(str::to_owned),
        warn_ms: to_number_of(quiet.get("warnMs")),
    })
}

#[test]
fn the_spinner_byline_matches() {
    let golden = golden();
    let meta = &golden["spinnerMeta"];
    for case in meta["cases"].as_array().expect("cases") {
        let input = &case["input"];
        let effort = input.get("effort").and_then(Value::as_str).unwrap_or("");
        let built = build_spinner_meta(&SpinnerMetaInput {
            output_tokens: number_or(input, "outputTokens", 0.0),
            thinking: Thinking {
                thinking: input.get("thinking").and_then(Value::as_bool).unwrap_or(false),
                thinking_since: number_or(input, "thinkingSince", 0.0),
                thinking_ms: number_or(input, "thinkingMs", 0.0),
                effort,
            },
            quiet: quiet_of(input),
            now: number_or(input, "now", 0.0),
        });
        assert_eq!(serde_json::to_value(&built).expect("serialises"), case["output"], "{input}");
    }
    for row in meta["reducedMotion"].as_array().expect("rows") {
        assert_eq!(is_reduced_motion(row["value"].as_str()), row["reduced"].as_bool().unwrap(), "{row}");
    }
}

#[test]
fn the_spinner_verbs_match() {
    let golden = golden();
    let verbs = &golden["spinnerVerbs"];
    assert_eq!(SPINNER_VERBS.to_vec(), strings(&verbs["verbs"]));
    assert_eq!(SPINNER_FRAMES.to_vec(), strings(&verbs["frames"]));
    let overrides: BTreeMap<&str, &str> = verbs["overrides"].as_object().expect("overrides").iter().map(|(k, v)| (k.as_str(), text(v))).collect();
    assert_eq!(SPINNER_MODE_OVERRIDE_VERBS.iter().copied().collect::<BTreeMap<_, _>>(), overrides);
    for row in verbs["cases"].as_array().expect("cases") {
        let started = number(&row["startedAt"]);
        for pair in row["now"].as_array().expect("rows") {
            assert_eq!(spinner_verb_for(started, number(&pair[0])), text(&pair[1]), "{started} {}", pair[0]);
        }
    }
    for row in verbs["odd"].as_array().expect("odd") {
        assert_eq!(spinner_verb_for(number(&row["startedAt"]), number(&row["now"])), text(&row["verb"]), "{row}");
    }
    for row in verbs["customPools"].as_array().expect("pools") {
        let pool = strings(&row["pool"]);
        let started = number(&row["startedAt"]);
        let got: Vec<String> =
            row["offsets"].as_array().expect("offsets").iter().map(|o| spinner_verb_in(started, started + number(o), &pool)).collect();
        assert_eq!(got, strings(&row["verbs"]), "{row}");
    }
}

#[test]
fn the_duration_labels_match() {
    let golden = golden();
    let time = &golden["timeFormat"];
    for set in time["duration"].as_array().expect("sets") {
        let options = DurationOptions {
            most_significant_only: set["options"]["mostSignificantOnly"].as_bool().unwrap_or(false),
            hide_trailing_zeros: set["options"]["hideTrailingZeros"].as_bool().unwrap_or(false),
        };
        for row in set["rows"].as_array().expect("rows") {
            assert_eq!(format_duration(number(&row[0]), options), text(&row[1]), "{options:?} {}", row[0]);
        }
    }
    for row in time["nonFinite"].as_array().expect("rows") {
        let value = edge_value(&row["tag"]);
        assert_eq!(format_duration(value, DurationOptions::default()), text(&row["duration"]), "{}", row["tag"]);
        assert_eq!(format_elapsed(value), text(&row["elapsed"]), "{}", row["tag"]);
    }
    for row in time["elapsed"].as_array().expect("rows") {
        assert_eq!(format_elapsed(number(&row[0])), text(&row[1]), "{}", row[0]);
    }
}

#[test]
fn a_colour_equals_its_css_text() {
    assert_eq!(Color::Rgb(1, 2, 3).css(), "rgb(1,2,3)");
    assert_eq!(Color::Transparent.css(), "transparent");
}

/// Node's fresh recording compared with the golden (the recorder's own `--check`), where node and the tree exist. The tree
/// is `C:/Project/mixdog` unless `MIXDOG_STYLE_TREE` names another checkout of the Node code.
#[test]
#[ignore = "runs node over the Node tree (see the recorder)"]
fn live_style() {
    let crate_dir = env!("CARGO_MANIFEST_DIR");
    let tree = std::env::var("MIXDOG_STYLE_TREE").unwrap_or_else(|_| "C:/Project/mixdog".to_owned());
    let status = Command::new("node")
        .arg(format!("{crate_dir}/tests/recorders/record-style.mjs"))
        .args(["--tree", &tree, "--check", &format!("{crate_dir}/tests/goldens/style.json")])
        .status()
        .expect("node starts");
    assert!(status.success(), "a fresh Node recording differs from goldens/style.json or src/palette.rs");
}
