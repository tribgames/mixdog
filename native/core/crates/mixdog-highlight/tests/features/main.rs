//! What a caller of the highlighter gets: HTML for a language, detection, name lookup, and the terminal colouring of the HTML.

use std::collections::HashMap;

use mixdog_highlight::{HighlightError, HighlightTheme, SgrStyle, highlight, highlight_ansi, highlight_auto, list_languages, supports_language};

fn html(code: &str, language: &str) -> String {
    highlight(code, language, true).expect("a carried language").value
}

fn visible_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#x27;", "'").replace("&amp;", "&")
}

#[test]
fn keywords_numbers_and_strings_get_their_classes() {
    assert_eq!(html("const n = 42;", "javascript"), "<span class=\"hljs-keyword\">const</span> n = <span class=\"hljs-number\">42</span>;");
    assert_eq!(html("let s = 'a';", "javascript"), "<span class=\"hljs-keyword\">let</span> s = <span class=\"hljs-string\">&#x27;a&#x27;</span>;");
}

#[test]
fn comments_and_python_definitions_are_marked() {
    let python = html("def f(x):\n    return x  # done", "python");
    assert!(python.contains("<span class=\"hljs-keyword\">def</span>"), "{python}");
    assert!(python.contains("<span class=\"hljs-title\">f</span>"), "{python}");
    assert!(python.contains("<span class=\"hljs-comment\"># done</span>"), "{python}");
}

#[test]
fn highlighting_never_changes_the_text_in_any_carried_language() {
    let code = "x = 1 < 2 && \"a\" // note\n\tif (y) { z(); }\n";
    let languages = list_languages();
    assert!(languages.len() > 20, "{} languages", languages.len());
    for language in &languages {
        let result = highlight(code, language, true).unwrap_or_else(|error| panic!("{language}: {error}"));
        assert_eq!(visible_text(&result.value), code, "text changed by {language}");
    }
}

#[test]
fn a_name_an_alias_or_a_different_case_finds_the_language() {
    for name in ["javascript", "JavaScript", "js", "python", "py", "json", "xml", "html", "sh"] {
        assert!(supports_language(name), "{name}");
    }
    assert!(!supports_language("no-such-language"));
    assert!(!supports_language(""));
}

#[test]
fn the_language_list_has_each_language_once_and_the_common_ones() {
    let languages = list_languages();
    let mut sorted = languages.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), languages.len(), "a language is listed twice");
    for name in ["javascript", "python", "json", "xml", "css", "bash", "rust", "go", "sql"] {
        assert!(languages.iter().any(|language| language == name), "{name} is not listed");
    }
}

#[test]
fn an_unknown_language_is_an_error_that_names_it() {
    let error = highlight("x", "no-such-language", true).expect_err("unknown");
    assert!(matches!(error, HighlightError::UnknownLanguage(_)));
    assert_eq!(error.to_string(), "Unknown language: \"no-such-language\"");
}

#[test]
fn illegal_text_is_reported_unless_illegals_are_ignored() {
    let strict = highlight("{ x }", "json", false).expect("runs");
    assert!(strict.illegal);
    assert_eq!(strict.value, "{ x }", "the text comes back escaped but unmarked");
    assert!(!highlight("{ x }", "json", true).expect("runs").illegal);
}

#[test]
fn detection_prefers_the_candidate_with_the_most_relevance() {
    let json = highlight_auto("{\"a\": 1, \"b\": [true, null]}", Some(&["json", "javascript"])).expect("runs");
    assert_eq!(json.language.as_deref(), Some("json"));
    let python = highlight_auto("def f(x):\n    return x\n\nprint(f(1))\n", Some(&["python", "json", "css"])).expect("runs");
    assert_eq!(python.language.as_deref(), Some("python"));
    assert!(python.relevance > 0);
}

#[test]
fn markup_embeds_a_script_in_a_wrapper_without_the_class_prefix() {
    let page = html("<script>var x = 1;</script>", "xml");
    assert!(page.contains("<span class=\"javascript\"><span class=\"hljs-keyword\">var</span>"), "{page}");
}

fn red_keywords() -> HighlightTheme {
    let mut classes = HashMap::new();
    classes.insert("keyword".to_owned(), SgrStyle::foreground_rgb(255, 0, 0));
    HighlightTheme { classes, default: SgrStyle::identity() }
}

#[test]
fn a_themed_class_is_wrapped_in_its_colour_and_the_rest_is_left_plain() {
    let painted = highlight_ansi("var x = 1;", "javascript", &red_keywords(), true).expect("runs");
    assert_eq!(painted, "\x1b[38;2;255;0;0mvar\x1b[39m x = 1;");
}

#[test]
fn colouring_adds_no_visible_text() {
    for language in ["javascript", "python", "json"] {
        let painted = highlight_ansi("a = 1 # c\n", language, &red_keywords(), true).expect("runs");
        let plain: String = {
            let mut out = String::new();
            let mut chars = painted.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\x1b' {
                    for next in chars.by_ref() {
                        if next == 'm' {
                            break;
                        }
                    }
                } else {
                    out.push(c);
                }
            }
            out
        };
        assert_eq!(plain, "a = 1 # c\n", "{language}");
    }
}

#[test]
fn an_empty_language_detects_one() {
    let painted = highlight_ansi("{\"a\": 1}", "", &red_keywords(), true).expect("runs");
    assert!(painted.contains("\"a\""));
}
