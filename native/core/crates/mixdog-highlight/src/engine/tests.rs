use super::*;

fn html(code: &str, language: &str) -> String {
    Engine::new().highlight(code, language, true).expect("highlights").value
}

#[test]
fn every_carried_language_compiles_and_every_matcher_builds() {
    let engine = Engine::new();
    assert!(engine.list_languages().len() >= 37);
    for name in engine.list_languages() {
        let slot = engine.get_language(&name).expect("registered");
        let compiled = engine.compiled(slot).unwrap_or_else(|e| panic!("{name}: {e}"));
        for (index, mode) in compiled.modes.iter().enumerate() {
            assert!(mode.matcher.every_alternation_compiles(), "{name}: mode {index} has a pattern regress rejects");
            assert!(mode.keyword_pattern.get().is_some(), "{name}: mode {index} keyword pattern");
            if let Some(end) = mode.end_re.borrow().as_ref() {
                assert!(end.get().is_some(), "{name}: mode {index} end pattern");
            }
        }
    }
}

#[test]
fn names_and_aliases_resolve_case_insensitively() {
    let engine = Engine::new();
    assert!(engine.supports_language("JavaScript"));
    assert!(engine.supports_language("js"));
    assert!(engine.supports_language("html"));
    assert!(engine.supports_language("sh"));
    // highlight.js 10.7.3's alias table maps `tsx` to typescript; graphql is not a language of it.
    assert!(engine.supports_language("tsx"));
    assert!(!engine.supports_language("graphql"));
    assert!(!engine.supports_language(""));
    assert!(!engine.supports_language("no-such-language"));
}

#[test]
fn an_unknown_language_is_an_error() {
    let engine = Engine::new();
    assert_eq!(engine.highlight("x", "no-such-language", true).unwrap_err(), HighlightError::UnknownLanguage("no-such-language".to_string()));
}

#[test]
fn javascript_keywords_numbers_and_strings() {
    assert_eq!(
        html("const a = 1; // hi\nlet s = \"x\";", "javascript"),
        "<span class=\"hljs-keyword\">const</span> a = <span class=\"hljs-number\">1</span>; <span class=\"hljs-comment\">// hi</span>\n<span class=\"hljs-keyword\">let</span> s = <span class=\"hljs-string\">&quot;x&quot;</span>;"
    );
}

#[test]
fn json_values() {
    assert_eq!(
        html("{\"a\": [1, true]}", "json"),
        "{<span class=\"hljs-attr\">&quot;a&quot;</span>: [<span class=\"hljs-number\">1</span>, <span class=\"hljs-literal\">true</span>]}"
    );
}

#[test]
fn html_embeds_javascript_in_a_wrapper_span_without_the_prefix() {
    assert_eq!(
        html("<script>var x = 1;</script>", "xml"),
        "<span class=\"hljs-tag\">&lt;<span class=\"hljs-name\">script</span>&gt;</span><span class=\"javascript\"><span class=\"hljs-keyword\">var</span> x = <span class=\"hljs-number\">1</span>;</span><span class=\"hljs-tag\">&lt;/<span class=\"hljs-name\">script</span>&gt;</span>"
    );
}

#[test]
fn a_shebang_is_a_meta_only_at_the_start() {
    assert_eq!(html("#!/bin/bash\necho hi", "bash"), "<span class=\"hljs-meta\">#!/bin/bash</span>\n<span class=\"hljs-built_in\">echo</span> hi");
    assert_eq!(html("echo hi\n#!/bin/bash", "bash"), "<span class=\"hljs-built_in\">echo</span> hi\n<span class=\"hljs-comment\">#!/bin/bash</span>");
}

#[test]
fn text_with_no_match_is_escaped_whole() {
    assert_eq!(html("a < b && c > d", "json"), "a &lt; b &amp;&amp; c &gt; d");
}

#[test]
fn illegal_text_is_returned_escaped_when_illegals_are_not_ignored() {
    let result = Engine::new().highlight("{ x }", "json", false).expect("runs");
    assert!(result.illegal);
    assert_eq!(result.value, "{ x }");
    assert_eq!(result.relevance, 0);
}

#[test]
fn highlight_auto_picks_the_language_with_the_most_relevance() {
    let engine = Engine::new();
    let result = engine.highlight_auto("{\"a\": 1}", Some(&["json", "javascript"])).expect("runs");
    assert_eq!(result.language.as_deref(), Some("json"));
    let plain = engine.highlight_auto("hello", Some(&["json"])).expect("runs");
    assert_eq!(plain.language, None);
    assert_eq!(plain.value, "hello");
}

#[test]
fn a_surrogate_pair_in_the_text_survives() {
    assert_eq!(html("x = \"\u{1F600}\"", "javascript").matches('\u{1F600}').count(), 1);
}
