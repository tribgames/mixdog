//! Twin of highlight.js 10.7.3 and cli-highlight 2.1.11 for the languages beyond the core set, and for the whole
//! registry: the recorded Node run is `goldens/highlight-all.json` (`tests/recorders/record-highlight.mjs --all`).

use mixdog_highlight::{
    HighlightTheme, SgrStyle, highlight, highlight_ansi, highlight_auto, list_languages,
    supports_language,
};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/highlight-all.json");
const CORE_GOLDEN: &str = include_str!("goldens/highlight-core.json");

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
fn the_golden_records_the_pinned_versions_and_every_language() {
    let g = golden();
    assert_eq!(g["versions"]["highlightjs"], "10.7.3");
    assert_eq!(g["versions"]["cliHighlight"], "2.1.11");
    assert_eq!(g["languages"].as_array().expect("languages").len(), 191);
    assert!(g["cases"].as_array().expect("cases").len() > 3000);
}

#[test]
fn every_registered_language_is_listed_in_registration_order() {
    let g = golden();
    let expected: Vec<&str> = g["languages"]
        .as_array()
        .expect("languages")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let got = list_languages();
    assert_eq!(got.iter().map(String::as_str).collect::<Vec<_>>(), expected);
}

#[test]
fn every_language_outside_the_core_set_has_cases() {
    let g = golden();
    let cases = g["cases"].as_array().expect("cases");
    let core: Value = serde_json::from_str(CORE_GOLDEN).expect("core golden is JSON");
    let core: Vec<&str> = core["languages"]
        .as_array()
        .expect("languages")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for name in list_languages() {
        if core.contains(&name.as_str()) {
            continue;
        }
        assert!(
            cases.iter().any(|c| c["lang"] == name.as_str()),
            "no case for {name}"
        );
    }
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
    assert!(compared > 3000, "only {compared} ANSI comparisons");
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
                "subset of {}: language {:?} (expected {expected_language:?}), relevance {} (expected {}), {}",
                subset.len(),
                got.language,
                got.relevance,
                case["relevance"],
                first_difference(text(case, "html"), &got.value)
            ));
        }
    }
    report(failures, "auto", cases.len());
}

/// `supportsLanguage` and the alias table for every registered name, every alias and the odd names, in both cases.
#[test]
fn every_name_and_alias_resolves_as_in_node() {
    let g = golden();
    let resolve = g["resolve"].as_array().expect("resolve");
    assert!(resolve.len() > 700);
    for entry in resolve {
        let name = entry[0].as_str().expect("name");
        let node_supports = entry[1].as_bool().expect("supports");
        let carried = entry[2].as_str();
        // Every language of the registry is carried: Node supports a name exactly when this crate does.
        assert_eq!(carried.is_some(), node_supports, "carried({name:?})");
        assert_eq!(
            supports_language(name),
            node_supports,
            "supportsLanguage({name:?})"
        );
        if let Some(registered) = carried {
            let direct = highlight("x", name, true).expect("a supported name highlights");
            let by_registered =
                highlight("x", registered, true).expect("the registered name highlights");
            assert_eq!(
                direct.value, by_registered.value,
                "{name:?} does not resolve to {registered:?}"
            );
        }
    }
}

/// Node's time for every case of the golden is in it; the engine must not be slower.
#[test]
#[ignore = "timing: run with --ignored live_highlight_all on an otherwise idle machine"]
fn live_highlight_all_languages_is_not_slower_than_node() {
    let g = golden();
    let cases = g["cases"].as_array().expect("cases");
    let pass = || {
        for case in cases {
            highlight(text(case, "code"), text(case, "lang"), true).expect("highlights");
        }
    };
    // The first pass compiles every language; Node's figure is of a warmed-up pass too.
    pass();
    let mut times = Vec::new();
    for _ in 0..5 {
        let started = std::time::Instant::now();
        pass();
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    let rust_ms = times[2];
    let node_ms = g["allBench"]["nodeMs"].as_f64().expect("nodeMs");
    assert_eq!(
        g["allBench"]["cases"].as_u64().expect("cases"),
        cases.len() as u64
    );
    assert!(
        rust_ms <= node_ms,
        "Rust took {rust_ms:.1} ms for {} cases, Node {node_ms:.1} ms",
        cases.len()
    );
}
