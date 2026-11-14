//! Twin of highlight.js 10.7.3 and cli-highlight 2.1.11: the Rust engine and ANSI conversion answer what the
//! recorded Node run answered (`goldens/highlight-core.json`, from `tests/recorders/record-highlight.mjs`).

use mixdog_highlight::{
    HighlightTheme, SgrStyle, highlight, highlight_ansi, highlight_auto, list_languages,
    supports_language,
};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/highlight-core.json");
const BENCH_SOURCE: &str = include_str!("corpus/javascript.txt");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden is JSON")
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string {key}"))
}

fn style(v: &Value) -> SgrStyle {
    match v.as_array() {
        Some(rgb) => {
            let c = |i: usize| rgb[i].as_u64().expect("a colour channel") as u8;
            SgrStyle::foreground_rgb(c(0), c(1), c(2))
        }
        None => SgrStyle::identity(),
    }
}

fn theme(golden: &Value, name: &str) -> HighlightTheme {
    let recorded = &golden["themes"][name];
    let classes = recorded["classes"]
        .as_object()
        .expect("classes")
        .iter()
        .map(|(class, rgb)| (class.clone(), style(rgb)))
        .collect();
    HighlightTheme {
        classes,
        default: style(&recorded["default"]),
    }
}

/// The first place two strings differ, with some context: failures must not print whole documents.
fn first_difference(expected: &str, got: &str) -> String {
    let at = expected
        .chars()
        .zip(got.chars())
        .take_while(|(a, b)| a == b)
        .count();
    let clip = |s: &str| {
        s.chars()
            .skip(at.saturating_sub(40))
            .take(100)
            .collect::<String>()
    };
    format!(
        "differs at char {at}\n  expected: {:?}\n  got:      {:?}",
        clip(expected),
        clip(got)
    )
}

fn report(failures: Vec<String>, what: &str, total: usize) {
    assert!(
        failures.is_empty(),
        "{what}: {} of {total} cases differ; first ones:\n{}",
        failures.len(),
        failures
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_golden_records_the_pinned_versions() {
    let g = golden();
    assert_eq!(g["versions"]["highlightjs"], "10.7.3");
    assert_eq!(g["versions"]["cliHighlight"], "2.1.11");
    assert!(g["cases"].as_array().expect("cases").len() > 3000);
}

#[test]
fn every_core_language_is_listed_in_registration_order() {
    let g = golden();
    let expected: Vec<&str> = g["languages"]
        .as_array()
        .expect("languages")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    // The core set is carried in registration order among the other languages (`highlight_all_twin.rs`).
    let got = list_languages();
    let carried_core: Vec<&str> = got
        .iter()
        .map(String::as_str)
        .filter(|name| expected.contains(name))
        .collect();
    assert_eq!(carried_core, expected);
}

#[test]
fn html_matches_highlight_js_for_every_case() {
    let g = golden();
    let cases = g["cases"].as_array().expect("cases");
    let mut failures = Vec::new();
    for case in cases {
        let (lang, code) = (text(case, "lang"), text(case, "code"));
        let got = highlight(code, lang, true)
            .unwrap_or_else(|e| panic!("{lang} {}: {e}", text(case, "source")));
        if got.value != text(case, "html") {
            failures.push(format!(
                "{lang} {}: {}",
                text(case, "source"),
                first_difference(text(case, "html"), &got.value)
            ));
        }
    }
    report(failures, "html", cases.len());
}

#[test]
fn illegal_results_and_relevance_match_for_every_case() {
    let g = golden();
    let cases = g["cases"].as_array().expect("cases");
    let mut failures = Vec::new();
    for case in cases {
        let (lang, code) = (text(case, "lang"), text(case, "code"));
        let strict = &case["strict"];
        let got = highlight(code, lang, false).unwrap_or_else(|e| panic!("{lang}: {e}"));
        let same = got.value == text(strict, "value")
            && got.illegal == strict["illegal"].as_bool().expect("illegal")
            && got.relevance == strict["relevance"].as_i64().expect("relevance");
        if !same {
            failures.push(format!(
                "{lang} {}: illegal {} (expected {}), relevance {} (expected {}), {}",
                text(case, "source"),
                got.illegal,
                strict["illegal"],
                got.relevance,
                strict["relevance"],
                first_difference(text(strict, "value"), &got.value)
            ));
        }
    }
    report(failures, "strict", cases.len());
}

#[test]
fn ansi_matches_cli_highlight_under_every_recorded_theme() {
    let g = golden();
    let cases = g["cases"].as_array().expect("cases");
    let themes: Vec<(String, HighlightTheme)> = g["themes"]
        .as_object()
        .expect("themes")
        .keys()
        .map(|name| (name.clone(), theme(&g, name)))
        .collect();
    assert_eq!(themes.len(), 3);
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in cases {
        let (lang, code) = (text(case, "lang"), text(case, "code"));
        for (name, theme) in &themes {
            let Some(expected) = case["ansi"][name].as_str() else {
                continue;
            };
            compared += 1;
            let got =
                highlight_ansi(code, lang, theme, true).unwrap_or_else(|e| panic!("{lang}: {e}"));
            if got != expected {
                failures.push(format!(
                    "{lang} {} [{name}]: {}",
                    text(case, "source"),
                    first_difference(expected, &got)
                ));
            }
        }
    }
    assert!(compared > 4000, "only {compared} ANSI comparisons");
    report(failures, "ansi", compared);
}

#[test]
fn auto_detection_picks_the_same_language_and_relevance() {
    let g = golden();
    let cases = g["auto"].as_array().expect("auto cases");
    let mut failures = Vec::new();
    for case in cases {
        let subset: Vec<&str> = case["subset"]
            .as_array()
            .expect("subset")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let got = highlight_auto(text(case, "code"), Some(&subset)).expect("auto highlight runs");
        let expected_language = case["language"].as_str();
        let same = got.language.as_deref() == expected_language
            && got.relevance == case["relevance"].as_i64().expect("relevance")
            && got.value == text(case, "html");
        if !same {
            failures.push(format!(
                "subset {subset:?}: language {:?} (expected {expected_language:?}), relevance {} (expected {}), {}",
                got.language,
                got.relevance,
                case["relevance"],
                first_difference(text(case, "html"), &got.value)
            ));
        }
    }
    report(failures, "auto", cases.len());
}

#[test]
fn language_names_and_aliases_resolve_as_in_node() {
    let g = golden();
    for entry in g["resolve"].as_array().expect("resolve") {
        let name = entry[0].as_str().expect("name");
        let node_supports = entry[1].as_bool().expect("supports");
        // The golden marks a language outside the core set as not carried; the crate carries every registered one.
        assert_eq!(
            supports_language(name),
            node_supports,
            "supportsLanguage({name:?})"
        );
    }
}

/// Node's time for the same 5,000-line file is in the golden; the engine must not be slower.
#[test]
#[ignore = "timing: run with --ignored live_highlight on an otherwise idle machine"]
fn live_highlight_benchmark_five_thousand_lines() {
    let g = golden();
    let bench = &g["bench"];
    let source = BENCH_SOURCE.replace("\r\n", "\n");
    let joined = source
        .trim_end_matches('\n')
        .split("\n@@@@\n")
        .collect::<Vec<_>>()
        .join("\n");
    let mut lines: Vec<&str> = Vec::new();
    while lines.len() < 5000 {
        lines.extend(joined.split('\n'));
    }
    let code = lines[..5000].join("\n");
    assert_eq!(
        code.encode_utf16().count() as u64,
        bench["bytes"].as_u64().expect("bytes")
    );

    // The first run compiles the language; Node's figure is of a warmed-up run too.
    let first = highlight(&code, "javascript", true).expect("highlights");
    assert_eq!(
        first.value.encode_utf16().count() as u64,
        bench["htmlLength"].as_u64().expect("htmlLength")
    );
    let mut times = Vec::new();
    for _ in 0..7 {
        let started = std::time::Instant::now();
        let again = highlight(&code, "javascript", true).expect("highlights");
        times.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(again.value.len(), first.value.len());
    }
    times.sort_by(f64::total_cmp);
    let rust_ms = times[3];
    let node_ms = bench["nodeMs"].as_f64().expect("nodeMs");
    assert!(
        rust_ms <= node_ms,
        "Rust took {rust_ms:.1} ms for 5,000 lines, Node {node_ms:.1} ms"
    );
}
